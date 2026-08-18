import { spawn as spawnChild } from "node:child_process";
import { createRequire } from "node:module";

/**
 * The PTY backends behind the "Ask agent" session.
 *
 * Preferred: node-pty (shipped as `@homebridge/node-pty-prebuilt-multiarch`,
 * which carries prebuilt binaries so an install does not need a toolchain).
 * Loaded lazily and structurally, so the preview server still boots — and the
 * fallback still works — on a machine where the native module cannot load.
 *
 * Fallback: a plain `child_process` pipe. No real TTY (line-buffered output,
 * no winsize, `TERM=dumb`), so the CLI's full-screen UI is degraded, but the
 * session still runs and every lifecycle guarantee — project cwd, clean kill —
 * holds.
 */

/** What a session needs from a spawned process, whatever backend produced it. */
export interface AgentPtyProcess {
  /** OS pid, or undefined when the backend cannot report one. */
  pid?: number;
  write(data: string): void;
  /** Optional — the child_process fallback has no winsize to keep in sync. */
  resize?(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number | null }) => void): void;
}

export interface AgentPtySpawnOptions {
  /** Absolute path of the binary to run. Never a shell command line. */
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export type AgentPtySpawner = (options: AgentPtySpawnOptions) => AgentPtyProcess;

/** Structural shape of node-pty's module surface (never imported as a type). */
interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
    },
  ): {
    pid: number;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    onData(listener: (data: string) => void): void;
    onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  };
}

const PTY_PACKAGES = ["@homebridge/node-pty-prebuilt-multiarch", "node-pty"];

/** Load the first PTY package whose native binding actually loads. */
function loadNodePty(
  requireModule: (name: string) => unknown = createRequire(import.meta.url),
): NodePtyModule | null {
  for (const packageName of PTY_PACKAGES) {
    try {
      const loaded = requireModule(packageName);
      if (
        loaded !== null &&
        typeof loaded === "object" &&
        typeof (loaded as { spawn?: unknown }).spawn === "function"
      ) {
        return loaded as NodePtyModule;
      }
    } catch {
      // Missing package or an ABI-mismatched native binding — try the next.
    }
  }
  return null;
}

function nodePtySpawner(pty: NodePtyModule): AgentPtySpawner {
  return (options) => {
    const proc = pty.spawn(options.file, options.args, {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: options.env,
    });
    return {
      pid: proc.pid,
      write: (data) => proc.write(data),
      resize: (cols, rows) => proc.resize(cols, rows),
      kill: () => proc.kill(),
      onData: (listener) => proc.onData(listener),
      onExit: (listener) => proc.onExit(({ exitCode }) => listener({ exitCode })),
    };
  };
}

function childProcessSpawner(): AgentPtySpawner {
  return (options) => {
    const child = spawnChild(options.file, options.args, {
      cwd: options.cwd,
      env: { ...options.env, TERM: "dumb" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const dataListeners: Array<(data: string) => void> = [];
    const emit = (chunk: Buffer): void => {
      const text = chunk.toString("utf-8");
      for (const listener of dataListeners) listener(text);
    };
    child.stdout?.on("data", emit);
    child.stderr?.on("data", emit);
    return {
      pid: child.pid ?? undefined,
      write: (data) => {
        child.stdin?.write(data);
      },
      kill: () => {
        child.kill();
      },
      onData: (listener) => {
        dataListeners.push(listener);
      },
      onExit: (listener) => {
        child.on("exit", (code) => listener({ exitCode: code }));
        // A spawn that never started still has to reach the client, or the
        // panel waits forever on a session that does not exist.
        child.on("error", () => listener({ exitCode: null }));
      },
    };
  };
}

/** The best PTY backend this install can load. */
export function createAgentPtySpawner(pty = loadNodePty()): AgentPtySpawner {
  return pty ? nodePtySpawner(pty) : childProcessSpawner();
}
