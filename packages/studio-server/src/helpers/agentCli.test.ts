import { describe, expect, it } from "vitest";
import { resolveAgentCli } from "./agentCli";

/**
 * Finding the Claude Code CLI. The case that matters is a preview server the
 * user did not start from their own shell: it inherits a PATH that contains
 * none of the places `claude` installs into, so a PATH-only search would
 * report "not installed" on a machine where it plainly is.
 */
describe("resolveAgentCli", () => {
  it("prefers PATH when it carries the CLI", () => {
    const found = resolveAgentCli({
      env: { PATH: "/opt/tools:/usr/local/bin", HOME: "/Users/x" },
      isExecutable: (path) => path === "/usr/local/bin/claude" || path === "/opt/tools/claude",
    });
    expect(found).toBe("/opt/tools/claude");
  });

  it("falls back to the known install locations when PATH is thin", () => {
    const found = resolveAgentCli({
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/Users/x" },
      isExecutable: (path) => path === "/Users/x/.claude/local/claude",
    });
    expect(found).toBe("/Users/x/.claude/local/claude");
  });

  it("answers null rather than a path that is not there", () => {
    expect(
      resolveAgentCli({ env: { PATH: "/usr/bin", HOME: "/Users/x" }, isExecutable: () => false }),
    ).toBeNull();
  });
});
