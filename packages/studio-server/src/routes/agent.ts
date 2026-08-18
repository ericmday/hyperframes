import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { StudioApiAdapter } from "../types.js";
import { resolveAgentCli } from "../helpers/agentCli.js";
import {
  agentSessions as processAgentSessions,
  AgentSessionError,
  type AgentSessionEvent,
  type AgentSessionService,
} from "../helpers/agentSessions.js";
import { agentRequestAllowed } from "../helpers/localOnly.js";

/**
 * The "Ask agent" session routes: the studio's element dialog talking to a
 * Claude Code CLI the server runs in the served project's directory.
 *
 * The client supplies MESSAGE TEXT and nothing else. The binary is resolved
 * server-side (`resolveAgentCli`) and the message travels as an argv entry, so
 * there is no channel here for a caller to name a program, add an argument, or
 * smuggle shell syntax.
 *
 * Output streams back over SSE rather than a websocket: SSE is the streaming
 * primitive this server already has (render progress, the file watcher), it
 * works identically under both hosts that mount this app, and a terminal's
 * bulk traffic is server→client anyway. Keystrokes go up as ordinary POSTs.
 */

const MAX_MESSAGE_LENGTH = 100_000;

/**
 * Appended to the FIRST message of a session only. The spawned CLI cannot
 * otherwise know it is running inside the studio's Ask-agent panel; without
 * this it behaves like any terminal agent and "verifies" its edits by
 * launching a preview server or opening a browser — a new window the user
 * never asked for, next to a studio that already hot-reloads every save.
 */
function studioSessionContext(host: string | undefined): string {
  const studioUrl = host ? `http://${host}/` : "the local studio";
  return [
    "## Studio session context",
    `This session runs inside the HyperFrames Studio "Ask agent" panel. The project is ALREADY OPEN in the studio at ${studioUrl}, and every saved file change hot-reloads in the open canvas.`,
    "- Edit the project files directly; the user watches the result live in the studio canvas.",
    "- Do NOT run `hyperframes preview`, start any server, open a browser or any new window, or launch a render to verify changes — the open studio is the verification surface.",
    "- If you need a still frame to check, use `hyperframes snapshot` (writes PNGs under snapshots/); never anything interactive.",
  ].join("\n");
}

function allowed(c: Context): boolean {
  // The node adapter builds `c.req.url` from the Host header, so the two agree
  // in production; the fallback is what makes the guard reachable from a test,
  // where `Host` is a forbidden header on a constructed Request.
  const host = c.req.header("host") ?? new URL(c.req.url).host;
  return agentRequestAllowed(host, c.req.header("origin"));
}

function fromError(c: Context, error: unknown) {
  if (error instanceof AgentSessionError) {
    return c.json({ error: error.code, message: error.message }, 409);
  }
  return c.json({ error: "agent_failed", message: String(error) }, 500);
}

export interface AgentRouteOptions {
  /** The session owner. Defaults to the process-wide one; injected in tests. */
  sessions?: AgentSessionService;
  /** CLI lookup. Injected in tests so no `claude` install is required. */
  resolveCli?: () => string | null;
}

export function registerAgentRoutes(
  api: Hono,
  adapter: StudioApiAdapter,
  options: AgentRouteOptions = {},
): void {
  const sessions = options.sessions ?? processAgentSessions;
  const findCli = options.resolveCli ?? (() => resolveAgentCli());

  /**
   * Every route here answers for one project and only over loopback, so both
   * checks live in one wrapper: a route that forgot either would be an open
   * door onto a process spawn.
   */
  const forProject =
    (handler: (c: Context, dir: string) => Response | Promise<Response>) =>
    async (c: Context): Promise<Response> => {
      if (!allowed(c)) return c.json({ error: "forbidden" }, 403);
      const project = await adapter.resolveProject(c.req.param("id") ?? "");
      if (!project) return c.json({ error: "not found" }, 404);
      return handler(c, project.dir);
    };

  /** Run a session call that only reports whether it worked. */
  const command = (act: (dir: string) => void) => (c: Context, dir: string) => {
    try {
      act(dir);
      return c.json({ ok: true });
    } catch (error) {
      return fromError(c, error);
    }
  };

  // Panel state on load: is a session already running, and can one be started?
  api.get(
    "/projects/:id/agent",
    forProject((c, dir) =>
      c.json({ session: sessions.get(dir), cliAvailable: findCli() !== null }),
    ),
  );

  /**
   * Ask. Starts the session on the first call and follows up on every one
   * after — the SAME CLI, because the value of the panel over the clipboard is
   * that the agent keeps what it has already read about the project.
   */
  api.post(
    "/projects/:id/agent/ask",
    forProject(async (c, dir) => {
      const body = (await c.req.json().catch(() => ({}))) as { message?: unknown };
      const message = typeof body.message === "string" ? body.message : "";
      if (message.trim() === "" || message.length > MAX_MESSAGE_LENGTH) {
        return c.json({ error: "invalid_payload", message: "message is required" }, 400);
      }

      const existing = sessions.get(dir);
      if (existing) {
        try {
          sessions.sendMessage(dir, message);
          return c.json({ session: existing, started: false });
        } catch (error) {
          return fromError(c, error);
        }
      }

      // A missing CLI is a plain answer, never a throw: the dialog keeps its
      // Copy prompt fallback for exactly this case.
      const cliPath = findCli();
      if (!cliPath) {
        return c.json(
          {
            error: "agent_cli_not_found",
            message:
              "Claude Code was not found. Install it, or copy the prompt into your own terminal.",
          },
          503,
        );
      }

      try {
        const host = c.req.header("host") ?? new URL(c.req.url).host;
        return c.json({
          session: sessions.create({
            cwd: dir,
            cliPath,
            prompt: `${message}\n\n${studioSessionContext(host)}`,
          }),
          started: true,
        });
      } catch (error) {
        return fromError(c, error);
      }
    }),
  );

  // Keystrokes from the panel's terminal widget.
  api.post(
    "/projects/:id/agent/input",
    forProject(async (c, dir) => {
      const body = (await c.req.json().catch(() => ({}))) as { data?: unknown };
      if (typeof body.data !== "string") {
        return c.json({ error: "invalid_payload", message: "data is required" }, 400);
      }
      return command((target) => sessions.write(target, body.data as string))(c, dir);
    }),
  );

  // The CLI's UI lays itself out to the winsize, so a panel drag has to say so.
  api.post(
    "/projects/:id/agent/resize",
    forProject(async (c, dir) => {
      const body = (await c.req.json().catch(() => ({}))) as { cols?: unknown; rows?: unknown };
      const cols = typeof body.cols === "number" ? Math.round(body.cols) : 0;
      const rows = typeof body.rows === "number" ? Math.round(body.rows) : 0;
      if (cols < 1 || cols > 1000 || rows < 1 || rows > 1000) {
        return c.json({ error: "invalid_payload", message: "cols/rows out of range" }, 400);
      }
      return command((target) => sessions.resize(target, cols, rows))(c, dir);
    }),
  );

  // Explicit end. Hiding the panel does NOT come through here — the agent is
  // usually mid-turn when the user goes back to the canvas.
  api.post(
    "/projects/:id/agent/close",
    forProject((c, dir) => c.json({ closed: sessions.close(dir) })),
  );

  // Output. The scrollback is replayed on connect, so a panel that opens after
  // the CLI printed its banner — or that was hidden and reopened — sees it.
  api.get(
    "/projects/:id/agent/stream",
    forProject((c, dir) => {
      if (!sessions.get(dir)) return c.json({ error: "agent_session_not_found" }, 404);

      return streamSSE(c, async (stream) => {
        // The service pushes; streamSSE pulls. The queue is the join, and it
        // holds output that arrives while a write is still in flight.
        const queue: AgentSessionEvent[] = [];
        let wake: (() => void) | null = null;
        const unsubscribe = sessions.subscribe(dir, (event) => {
          queue.push(event);
          wake?.();
        });
        stream.onAbort(() => {
          unsubscribe();
          wake?.();
        });

        try {
          while (!stream.aborted) {
            const event = queue.shift();
            if (!event) {
              await new Promise<void>((resolveWake) => {
                wake = resolveWake;
              });
              wake = null;
              continue;
            }
            await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
            if (event.type === "exit") break;
          }
        } finally {
          unsubscribe();
        }
      });
    }),
  );
}
