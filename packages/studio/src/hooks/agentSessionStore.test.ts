import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentSessionStore } from "./agentSessionStore";
import { jsonResponse, requestUrl } from "./fetchStubTestUtils";

/**
 * The panel's half of the one-session rule: an ask reaches the server as
 * message text and nothing else, and the answer is what decides whether a
 * session is live. The server is what actually keeps a follow-up in the same
 * CLI (see studio-server's agent routes) — here the contract is that the
 * dialog only closes when something was really sent.
 */
const session = { id: "agent-1", title: "Claude — demo", cwd: "/projects/demo", pid: 42 };

function reset() {
  useAgentSessionStore.setState({
    session: null,
    panelOpen: false,
    sending: false,
    error: null,
  });
}

describe("useAgentSessionStore", () => {
  beforeEach(reset);
  afterEach(() => {
    vi.unstubAllGlobals();
    reset();
  });

  it("sends only the message text and opens the panel on success", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls.push({ url: requestUrl(input), body: JSON.parse(String(init?.body)) });
        return jsonResponse({ session, started: true });
      }),
    );

    const sent = await useAgentSessionStore.getState().ask("demo", "Make the fade slower");

    expect(sent).toBe(true);
    expect(calls[0]?.url).toBe("/api/projects/demo/agent/ask");
    // No binary, no argv, no cwd: the server owns all of that.
    expect(calls[0]?.body).toEqual({ message: "Make the fade slower" });
    expect(useAgentSessionStore.getState()).toMatchObject({
      session,
      panelOpen: true,
      sending: false,
    });
  });

  it("keeps the panel shut and reports why when the CLI is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: "agent_cli_not_found", message: "Claude Code was not found." }),
            { status: 503, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const sent = await useAgentSessionStore.getState().ask("demo", "hello");

    expect(sent).toBe(false);
    expect(useAgentSessionStore.getState()).toMatchObject({
      session: null,
      panelOpen: false,
      error: "Claude Code was not found.",
    });
  });

  it("survives a server that is not there", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );

    expect(await useAgentSessionStore.getState().ask("demo", "hello")).toBe(false);
    expect(useAgentSessionStore.getState().error).toMatch(/studio server/);
  });

  it("drops the session and the panel when the session is ended", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ closed: true })),
    );
    useAgentSessionStore.setState({ session, panelOpen: true });

    await useAgentSessionStore.getState().endSession("demo");

    expect(useAgentSessionStore.getState()).toMatchObject({ session: null, panelOpen: false });
  });

  it("hiding the panel leaves the session running", () => {
    useAgentSessionStore.setState({ session, panelOpen: true });
    useAgentSessionStore.getState().setPanelOpen(false);
    expect(useAgentSessionStore.getState().session).toEqual(session);
  });

  it("clamps the panel width to the drawer's bounds", () => {
    useAgentSessionStore.getState().setPanelWidth(10);
    expect(useAgentSessionStore.getState().panelWidth).toBe(360);
    useAgentSessionStore.getState().setPanelWidth(99999);
    expect(useAgentSessionStore.getState().panelWidth).toBe(1200);
  });
});
