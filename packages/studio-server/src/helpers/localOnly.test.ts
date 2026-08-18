import { describe, expect, it } from "vitest";
import { agentRequestAllowed, isLoopbackHost } from "./localOnly";

/**
 * The agent routes start a program, so unlike the rest of the studio API they
 * are not satisfied by the loopback BIND alone: a remote page can point a
 * hostname it controls at 127.0.0.1 and reach a loopback-bound server, and
 * such a request carries its hostname rather than the bound one.
 */
describe("isLoopbackHost", () => {
  it("accepts the loopback names and the whole 127.0.0.0/8 block", () => {
    for (const host of ["localhost", "localhost:3002", "127.0.0.1:3002", "127.9.9.9", "[::1]:80"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it("rejects anything else, including a rebound hostname and a missing Host", () => {
    for (const host of [
      "studio.evil.test",
      "192.168.1.4:3002",
      "127.0.0.1.evil.test",
      "",
      undefined,
    ]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("agentRequestAllowed", () => {
  it("allows the studio's own same-origin request", () => {
    expect(agentRequestAllowed("localhost:3002", "http://localhost:3002")).toBe(true);
  });

  it("allows a request with no Origin at all (a plain navigation or curl)", () => {
    expect(agentRequestAllowed("127.0.0.1:3002", undefined)).toBe(true);
  });

  it("refuses a cross-site Origin even when the Host is loopback", () => {
    expect(agentRequestAllowed("localhost:3002", "https://evil.test")).toBe(false);
    expect(agentRequestAllowed("localhost:3002", "not a url")).toBe(false);
  });

  it("refuses a LAN-exposed preview server outright", () => {
    // `HYPERFRAMES_PREVIEW_HOST=0.0.0.0` opts into sharing files, not into
    // handing anyone on the network a CLI with the server user's authority.
    expect(agentRequestAllowed("192.168.1.4:3002", undefined)).toBe(false);
  });
});
