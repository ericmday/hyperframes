// isLoopbackHost is deliberately restated from the CLI (see the note below).
// fallow-ignore-file code-duplication
/**
 * The Host guard for routes that must only ever answer the studio itself.
 *
 * The studio API is unauthenticated by design — it is protected by being bound
 * to loopback (see `findPortAndServe`'s F-001 note in the CLI), which is a fine
 * posture for reading and writing files in a directory the user already owns.
 * Spawning a process is a step past that, so the agent routes add the same
 * Host pinning the CLI's telemetry-identity route uses: a remote page can point
 * a hostname it controls at 127.0.0.1 and read the response as same-origin, and
 * such a request carries the attacker's hostname rather than the bound one.
 *
 * Mirrors `isLoopbackHost` / `identityAllowed` in
 * `packages/cli/src/server/telemetryIdentity.ts`; studio-server cannot import
 * from the CLI (the dependency runs the other way), so the rule is restated
 * here rather than shared.
 */

/** True when a `Host` header names the loopback interface. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  // Strip the port. IPv6 literals are bracketed (`[::1]:1234`), so take the
  // bracketed part when present and only split on ":" otherwise.
  const bracketed = /^\[([^\]]+)\]/.exec(host);
  const hostname = (bracketed ? bracketed[1] : host.split(":")[0])?.toLowerCase() ?? "";
  if (hostname === "localhost" || hostname === "::1" || hostname === "0:0:0:0:0:0:0:1") return true;
  // 127.0.0.0/8 — the whole loopback block, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * True when the request may drive an agent session.
 *
 * Loopback Host always passes. An operator who deliberately exposed the
 * preview server (`HYPERFRAMES_PREVIEW_HOST=0.0.0.0`) does NOT get agent
 * sessions over the network: unlike a file write, this starts a program with
 * the server user's full authority, and no one binding a preview server to a
 * LAN is asking for that. A cross-site `Origin` is refused outright — a page
 * on another origin has no business starting a CLI here, and the studio's own
 * fetches always present the served origin.
 */
export function agentRequestAllowed(host: string | undefined, origin: string | undefined): boolean {
  if (!isLoopbackHost(host)) return false;
  if (origin === undefined || origin === "" || origin === "null") return true;
  try {
    return isLoopbackHost(new URL(origin).host);
  } catch {
    return false;
  }
}
