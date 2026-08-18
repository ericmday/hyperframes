import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Finding the Claude Code CLI for the studio's "Ask agent" panel.
 *
 * PATH is searched first — it is right whenever the preview server was started
 * from a terminal, which is the normal case for `hyperframes preview`. The
 * known install locations follow, because a server started from a launcher (a
 * desktop shortcut, a supervisor, an IDE task runner) inherits a PATH that
 * contains none of the places `claude` installs into, and would report "not
 * installed" on a machine where it plainly is.
 *
 * The ABSOLUTE path is what gets spawned. Resolving to a path rather than
 * shelling out through `$SHELL -lc` is also what keeps the prompt out of a
 * command line: the message is an argv entry, so no quote in it can ever
 * become shell syntax.
 */

/** The CLI this panel drives. Never client-supplied. */
export const AGENT_CLI_NAME = "claude";

/** Install locations to try when PATH does not carry the CLI, in order. */
function fallbackDirs(home: string): string[] {
  return [
    join(home, ".claude", "local"),
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
  ];
}

export interface ResolveAgentCliOptions {
  env?: Record<string, string | undefined>;
  /** Executable-file probe; injected in tests. */
  isExecutable?: (path: string) => boolean;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of the agent CLI, or null when it is not installed. */
export function resolveAgentCli(options: ResolveAgentCliOptions = {}): string | null {
  const env = options.env ?? process.env;
  const isExecutable = options.isExecutable ?? executable;
  const home = env["HOME"] ?? "";
  const pathDirs = (env["PATH"] ?? "").split(delimiter).filter((dir) => dir !== "");

  for (const dir of [...pathDirs, ...fallbackDirs(home)]) {
    const candidate = join(dir, AGENT_CLI_NAME);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}
