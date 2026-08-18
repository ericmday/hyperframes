import { basename } from "node:path";
import { createAgentPtySpawner, type AgentPtyProcess, type AgentPtySpawner } from "./agentPty.js";

/**
 * The "Ask agent" session: one Claude Code CLI per served project, owned by
 * the server, streamed to the studio's xterm panel.
 *
 * ONE session per project directory and it is the SESSION that persists — a
 * second ask writes a follow-up into the running CLI instead of starting a new
 * one, which is the whole point of the panel (the agent keeps everything it
 * has already read about the project). Starting over is an explicit act.
 *
 * The spawner is INJECTED, which is what lets the whole lifecycle (create in
 * the project dir, follow-up delivery, kill on close / shutdown, no orphans)
 * run in a plain unit test with a fake.
 */

export interface AgentSession {
  /** Opaque id, unique for the life of the process. */
  id: string;
  /** Panel title (`Claude — <project>`). */
  title: string;
  /** Absolute directory the CLI was started in (the served project). */
  cwd: string;
  /** OS pid, or null when the backend reports none. */
  pid: number | null;
}

/** One chunk of output, or the session's end. */
export type AgentSessionEvent =
  | { type: "data"; data: string }
  | { type: "exit"; exitCode: number | null };

const DEFAULT_AGENT_COLS = 100;
const DEFAULT_AGENT_ROWS = 30;

/**
 * How long a follow-up sits in the CLI's composer before it is submitted.
 *
 * The paste and the Return cannot go out in one write: a TUI reads them from
 * the same chunk and can submit before it has finished folding the pasted
 * block into its input. One tick of breathing room is all it needs, and a late
 * submit is invisible to the user — a dropped half-message would not be.
 */
const AGENT_MESSAGE_SUBMIT_DELAY_MS = 150;

/**
 * Output held for replay to a panel that attaches after the session started.
 * The CLI prints its banner before the browser has opened the stream, and a
 * reopened panel should not come back to a blank screen. A cap, because a
 * long-running session's scrollback is not the server's to hoard.
 */
const AGENT_SCROLLBACK_LIMIT = 256 * 1024;

export class AgentSessionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentSessionError";
    this.code = code;
  }
}

export interface AgentSessionCreateOptions {
  /** Absolute directory the CLI starts in (the served project). */
  cwd: string;
  /** Absolute path of the CLI binary, resolved by the server. */
  cliPath: string;
  /** The first prompt, delivered as an argv entry — never a command line. */
  prompt: string;
}

export interface AgentSessionServiceOptions {
  spawn?: AgentPtySpawner;
  /** Base environment; defaults to `process.env`. Injected for tests. */
  baseEnv?: Record<string, string | undefined>;
  /** Deferred work (the follow-up's submit); injected in tests. */
  schedule?: (task: () => void, ms: number) => void;
}

interface LiveSession {
  session: AgentSession;
  pty: AgentPtyProcess;
  listeners: Set<(event: AgentSessionEvent) => void>;
  scrollback: string[];
  scrollbackBytes: number;
  exited: boolean;
}

export class AgentSessionService {
  private readonly options: AgentSessionServiceOptions;
  private readonly byCwd = new Map<string, LiveSession>();
  private spawner: AgentPtySpawner | null = null;
  private counter = 0;

  constructor(options: AgentSessionServiceOptions = {}) {
    this.options = options;
  }

  /** The live session for a project, or null when none is running. */
  get(cwd: string): AgentSession | null {
    return this.byCwd.get(cwd)?.session ?? null;
  }

  /**
   * Start the CLI in `cwd` with `prompt` as its first message.
   *
   * The prompt travels as an argv entry, so nothing in it — quotes, newlines,
   * backticks — can become shell syntax; there is no shell in between at all.
   */
  create(options: AgentSessionCreateOptions): AgentSession {
    const existing = this.byCwd.get(options.cwd);
    if (existing) {
      throw new AgentSessionError(
        "agent_session_exists",
        "An agent session is already running for this project",
      );
    }

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.options.baseEnv ?? process.env)) {
      if (value !== undefined) env[key] = value;
    }

    // Lazy: loading the native PTY binding costs nothing on a server nobody
    // ever asks an agent from.
    this.spawner ??= this.options.spawn ?? createAgentPtySpawner();
    const pty = this.spawner({
      file: options.cliPath,
      args: [options.prompt],
      cwd: options.cwd,
      env,
      cols: DEFAULT_AGENT_COLS,
      rows: DEFAULT_AGENT_ROWS,
    });

    this.counter += 1;
    const session: AgentSession = {
      id: `agent-${this.counter}`,
      title: `Claude — ${basename(options.cwd)}`,
      cwd: options.cwd,
      pid: pty.pid ?? null,
    };
    const live: LiveSession = {
      session,
      pty,
      listeners: new Set(),
      scrollback: [],
      scrollbackBytes: 0,
      exited: false,
    };
    this.byCwd.set(options.cwd, live);

    pty.onData((data) => {
      live.scrollback.push(data);
      live.scrollbackBytes += data.length;
      while (live.scrollbackBytes > AGENT_SCROLLBACK_LIMIT && live.scrollback.length > 1) {
        live.scrollbackBytes -= live.scrollback.shift()?.length ?? 0;
      }
      for (const listener of live.listeners) listener({ type: "data", data });
    });
    pty.onExit(({ exitCode }) => {
      this.byCwd.delete(options.cwd);
      // A session the server itself tore down already announced its exit.
      if (live.exited) return;
      live.exited = true;
      for (const listener of live.listeners) listener({ type: "exit", exitCode });
    });

    return session;
  }

  /**
   * Send one follow-up prompt into a running session.
   *
   * Bracketed paste, then a Return a tick later. A message written raw would
   * be read as typing, and every newline in it would submit — a three-line
   * request would become three half-formed turns. Wrapped in the paste markers
   * it lands in the composer as one block, whatever it contains.
   *
   * ESC is stripped for the same reason a shell is avoided elsewhere: the only
   * way pasted text could end the paste early (or drive the TUI) is by
   * carrying its own control sequences.
   */
  sendMessage(cwd: string, text: string): void {
    const live = this.live(cwd);
    const safe = text.split("\u001b").join("");
    live.pty.write(`\u001b[200~${safe}\u001b[201~`);
    const submit = (): void => {
      // The CLI may have exited during the delay.
      const still = this.byCwd.get(cwd);
      if (still === live) still.pty.write("\r");
    };
    const schedule = this.options.schedule ?? ((task, ms) => void setTimeout(task, ms).unref?.());
    schedule(submit, AGENT_MESSAGE_SUBMIT_DELAY_MS);
  }

  /** Keystrokes from the panel's xterm widget. */
  write(cwd: string, data: string): void {
    this.live(cwd).pty.write(data);
  }

  // Called through the injected service in routes/agent.ts (the resize route).
  // fallow-ignore-next-line unused-class-member
  resize(cwd: string, cols: number, rows: number): void {
    this.live(cwd).pty.resize?.(cols, rows);
  }

  /**
   * Watch a session's output. The listener is replayed the scrollback first,
   * so a panel that attaches after the CLI has already printed its banner —
   * or that was hidden and reopened — comes back to what is on screen.
   */
  subscribe(cwd: string, listener: (event: AgentSessionEvent) => void): () => void {
    const live = this.live(cwd);
    for (const chunk of live.scrollback) listener({ type: "data", data: chunk });
    live.listeners.add(listener);
    return () => live.listeners.delete(listener);
  }

  /** Kill one project's CLI. Answers false when none was running. */
  close(cwd: string): boolean {
    const live = this.byCwd.get(cwd);
    if (!live) return false;
    this.kill(live);
    return true;
  }

  /**
   * Kill every CLI (server shutdown). Idempotent; the count is how many were
   * actually alive. No PTY may survive this call.
   */
  closeAll(): number {
    const all = [...this.byCwd.values()];
    for (const live of all) this.kill(live);
    return all.length;
  }

  private kill(live: LiveSession): void {
    // Remove first: the exit listener must not double-announce for a session
    // the server itself tore down.
    this.byCwd.delete(live.session.cwd);
    if (live.exited) return;
    live.exited = true;
    try {
      live.pty.kill();
    } catch {
      // Already dead — that is the goal state.
    }
    for (const listener of live.listeners) listener({ type: "exit", exitCode: null });
  }

  private live(cwd: string): LiveSession {
    const live = this.byCwd.get(cwd);
    if (!live) {
      throw new AgentSessionError("agent_session_not_found", "No agent session for this project");
    }
    return live;
  }
}

/**
 * The process-wide session owner.
 *
 * A singleton because the sessions are PTYs, not request state: the vite dev
 * host and the CLI host each build their own `createStudioApi()` app, and a
 * per-app store would let two of them own two CLIs in the same directory.
 */
export const agentSessions = new AgentSessionService();

/** Kill every agent session. Called from the preview server's shutdown path. */
export function closeAllAgentSessions(): number {
  return agentSessions.closeAll();
}

// Last-resort net for crash paths that bypass the server's own shutdown: a
// PTY that outlives the process it was spawned from is an orphaned `claude`
// holding the project directory open.
process.once("exit", () => {
  agentSessions.closeAll();
});
