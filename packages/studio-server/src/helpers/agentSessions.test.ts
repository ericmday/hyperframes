import { describe, expect, it } from "vitest";
import { AgentSessionService, type AgentSessionEvent } from "./agentSessions";
import type { AgentPtyProcess, AgentPtySpawnOptions } from "./agentPty";

const ESC = "\u001b";

interface FakePty extends AgentPtyProcess {
  written: string[];
  killed: boolean;
  emit(data: string): void;
  end(exitCode: number | null): void;
  spawnedWith: AgentPtySpawnOptions;
}

function fakeService(): { service: AgentSessionService; spawned: FakePty[]; run: () => void } {
  const spawned: FakePty[] = [];
  const pending: Array<() => void> = [];
  const service = new AgentSessionService({
    baseEnv: { HOME: "/Users/x" },
    schedule: (task) => pending.push(task),
    spawn: (options) => {
      let onData = (_: string) => {};
      let onExit = (_: { exitCode: number | null }) => {};
      const pty: FakePty = {
        pid: 4242,
        spawnedWith: options,
        written: [],
        killed: false,
        write: (data) => pty.written.push(data),
        resize: () => {},
        kill: () => {
          pty.killed = true;
        },
        onData: (listener) => {
          onData = listener;
        },
        onExit: (listener) => {
          onExit = listener;
        },
        emit: (data) => onData(data),
        end: (exitCode) => onExit({ exitCode }),
      };
      spawned.push(pty);
      return pty;
    },
  });
  return { service, spawned, run: () => pending.splice(0).forEach((task) => task()) };
}

describe("AgentSessionService", () => {
  it("starts the CLI in the project dir with the prompt as an argv entry", () => {
    const { service, spawned } = fakeService();
    const session = service.create({
      cwd: "/projects/demo",
      cliPath: "/usr/local/bin/claude",
      // Quotes and newlines would be shell syntax on a command line; here they
      // are just characters in one argument.
      prompt: 'Make the "fade"\nslower; rm -rf /',
    });

    expect(session.cwd).toBe("/projects/demo");
    expect(session.title).toBe("Claude — demo");
    expect(spawned[0]?.spawnedWith.file).toBe("/usr/local/bin/claude");
    expect(spawned[0]?.spawnedWith.args).toEqual(['Make the "fade"\nslower; rm -rf /']);
    expect(spawned[0]?.spawnedWith.cwd).toBe("/projects/demo");
  });

  it("keeps one session per project, so a second ask is a follow-up", () => {
    const { service, spawned } = fakeService();
    service.create({ cwd: "/projects/demo", cliPath: "/bin/claude", prompt: "first" });
    expect(() =>
      service.create({ cwd: "/projects/demo", cliPath: "/bin/claude", prompt: "second" }),
    ).toThrow(/already running/);
    expect(spawned).toHaveLength(1);
  });

  it("delivers a follow-up as one bracketed paste, submitted a tick later", () => {
    const { service, spawned, run } = fakeService();
    service.create({ cwd: "/projects/demo", cliPath: "/bin/claude", prompt: "first" });

    service.sendMessage("/projects/demo", "line one\nline two");
    // Before the scheduled submit runs there is exactly one write: a raw
    // multi-line message would already have submitted a half-formed turn.
    expect(spawned[0]?.written).toEqual([`${ESC}[200~line one\nline two${ESC}[201~`]);
    run();
    expect(spawned[0]?.written[1]).toBe("\r");
  });

  it("strips ESC so a message cannot end its own paste or drive the UI", () => {
    const { service, spawned } = fakeService();
    service.create({ cwd: "/projects/demo", cliPath: "/bin/claude", prompt: "first" });
    service.sendMessage("/projects/demo", `evil${ESC}[201~ and then some`);
    expect(spawned[0]?.written[0]).toBe(`${ESC}[200~evil[201~ and then some${ESC}[201~`);
  });

  it("replays the scrollback to a panel that attaches late", () => {
    const { service, spawned } = fakeService();
    service.create({ cwd: "/projects/demo", cliPath: "/bin/claude", prompt: "first" });
    spawned[0]?.emit("banner\n");
    spawned[0]?.emit("thinking…");

    const seen: AgentSessionEvent[] = [];
    service.subscribe("/projects/demo", (event) => seen.push(event));
    expect(seen).toEqual([
      { type: "data", data: "banner\n" },
      { type: "data", data: "thinking…" },
    ]);

    spawned[0]?.emit(" done");
    expect(seen[2]).toEqual({ type: "data", data: " done" });
  });

  it("announces the exit once, whether the CLI or the server ended it", () => {
    const { service, spawned } = fakeService();
    service.create({ cwd: "/projects/demo", cliPath: "/bin/claude", prompt: "first" });
    const seen: AgentSessionEvent[] = [];
    service.subscribe("/projects/demo", (event) => seen.push(event));

    expect(service.close("/projects/demo")).toBe(true);
    expect(spawned[0]?.killed).toBe(true);
    // The backend's own exit callback still fires after a kill.
    spawned[0]?.end(0);
    expect(seen.filter((event) => event.type === "exit")).toHaveLength(1);
    expect(service.get("/projects/demo")).toBeNull();
    // A second close has nothing left to kill.
    expect(service.close("/projects/demo")).toBe(false);
  });

  it("kills every session on shutdown", () => {
    const { service, spawned } = fakeService();
    service.create({ cwd: "/projects/a", cliPath: "/bin/claude", prompt: "x" });
    service.create({ cwd: "/projects/b", cliPath: "/bin/claude", prompt: "y" });
    expect(service.closeAll()).toBe(2);
    expect(spawned.every((pty) => pty.killed)).toBe(true);
    expect(service.closeAll()).toBe(0);
  });

  it("refuses to write into a session that is not running", () => {
    const { service } = fakeService();
    expect(() => service.write("/projects/demo", "x")).toThrow(/No agent session/);
  });
});
