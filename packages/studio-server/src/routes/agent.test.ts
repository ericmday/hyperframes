import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { registerAgentRoutes } from "./agent";
import { AgentSessionService } from "../helpers/agentSessions";
import type { AgentPtyProcess } from "../helpers/agentPty";
import type { StudioApiAdapter } from "../types";

function createAdapter(): StudioApiAdapter {
  return {
    listProjects: () => [],
    resolveProject: async (id: string) =>
      id === "demo" ? { id, dir: "/projects/demo", title: "Demo" } : null,
    bundle: async () => null,
    lint: async () => ({ findings: [] }),
    runtimeUrl: "/api/runtime.js",
    rendersDir: () => "/tmp/renders",
    startRender: () => ({
      id: "job-1",
      status: "rendering",
      progress: 0,
      outputPath: "/tmp/out.mp4",
    }),
  };
}

function createApp(cli: string | null = "/usr/local/bin/claude") {
  const spawned: Array<{ file: string; args: string[]; cwd: string; written: string[] }> = [];
  const sessions = new AgentSessionService({
    baseEnv: {},
    schedule: () => {},
    spawn: (options) => {
      const record = { file: options.file, args: options.args, cwd: options.cwd, written: [] };
      spawned.push(record);
      const pty: AgentPtyProcess = {
        pid: 1,
        write: (data) => record.written.push(data),
        resize: () => {},
        kill: () => {},
        onData: () => {},
        onExit: () => {},
      };
      return pty;
    },
  });
  const app = new Hono();
  registerAgentRoutes(app, createAdapter(), { sessions, resolveCli: () => cli });
  return { app, sessions, spawned };
}

// `Host` is a forbidden header on a constructed Request, so the loopback the
// guard reads comes from the request URL (which the node adapter builds from
// Host in production).
const local = { "Content-Type": "application/json" };

describe("registerAgentRoutes", () => {
  it("starts a session in the project dir and follows up into the same one", async () => {
    const { app, spawned } = createApp();

    const first = await app.request("http://localhost/projects/demo/agent/ask", {
      method: "POST",
      headers: local,
      body: JSON.stringify({ message: "Make the fade slower" }),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ started: true });
    expect(spawned[0]).toMatchObject({
      file: "/usr/local/bin/claude",
      cwd: "/projects/demo",
    });
    // The first message carries the user's request PLUS the studio-session
    // context — the CLI must know it lives inside the open studio, or it
    // "verifies" by launching its own preview window.
    expect(spawned[0]?.args).toHaveLength(1);
    expect(spawned[0]?.args[0]).toContain("Make the fade slower");
    expect(spawned[0]?.args[0]).toContain("## Studio session context");
    expect(spawned[0]?.args[0]).toContain("Do NOT run `hyperframes preview`");

    const second = await app.request("http://localhost/projects/demo/agent/ask", {
      method: "POST",
      headers: local,
      body: JSON.stringify({ message: "and slower still" }),
    });
    expect(await second.json()).toMatchObject({ started: false });
    // No second CLI: the agent keeps everything it has read about the project.
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.written[0]).toContain("and slower still");
  });

  it("says the CLI is missing instead of failing, so Copy prompt stays useful", async () => {
    const { app } = createApp(null);
    const response = await app.request("http://localhost/projects/demo/agent/ask", {
      method: "POST",
      headers: local,
      body: JSON.stringify({ message: "hello" }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "agent_cli_not_found" });
  });

  it("refuses a request that did not arrive over loopback", async () => {
    const { app, spawned } = createApp();
    const response = await app.request("http://evil.test/projects/demo/agent/ask", {
      method: "POST",
      headers: local,
      body: JSON.stringify({ message: "hello" }),
    });
    expect(response.status).toBe(403);
    expect(spawned).toHaveLength(0);
  });

  it("rejects an empty message", async () => {
    const { app } = createApp();
    const response = await app.request("http://localhost/projects/demo/agent/ask", {
      method: "POST",
      headers: local,
      body: JSON.stringify({ message: "   " }),
    });
    expect(response.status).toBe(400);
  });

  it("reports whether a session and a CLI are there", async () => {
    const { app } = createApp();
    const before = await app.request("http://localhost/projects/demo/agent", { headers: local });
    expect(await before.json()).toEqual({ session: null, cliAvailable: true });

    await app.request("http://localhost/projects/demo/agent/ask", {
      method: "POST",
      headers: local,
      body: JSON.stringify({ message: "hello" }),
    });
    const after = await app.request("http://localhost/projects/demo/agent", { headers: local });
    expect(await after.json()).toMatchObject({ session: { cwd: "/projects/demo" } });
  });

  it("closes the session on request and answers 404 for an unknown project", async () => {
    const { app, sessions } = createApp();
    await app.request("http://localhost/projects/demo/agent/ask", {
      method: "POST",
      headers: local,
      body: JSON.stringify({ message: "hello" }),
    });
    const closed = await app.request("http://localhost/projects/demo/agent/close", {
      method: "POST",
      headers: local,
    });
    expect(await closed.json()).toEqual({ closed: true });
    expect(sessions.get("/projects/demo")).toBeNull();

    const missing = await app.request("http://localhost/projects/nope/agent/close", {
      method: "POST",
      headers: local,
    });
    expect(missing.status).toBe(404);
  });
});
