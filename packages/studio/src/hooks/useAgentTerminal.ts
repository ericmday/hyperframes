import { useCallback, useRef, type RefObject } from "react";
import { useMountEffect } from "./useMountEffect";
import { useAgentSessionStore } from "./agentSessionStore";
import {
  createAgentTerminal,
  type AgentTerminalFactory,
  type AgentTerminalInstance,
} from "../utils/xtermTerminal";

/**
 * Wire one xterm widget to one server-side agent session.
 *
 * Output arrives over SSE and keystrokes go back as POSTs — the streaming
 * shape the studio server already uses everywhere else. The scrollback is
 * replayed by the server when the stream opens, so a panel that attaches after
 * the CLI printed its banner is not a blank screen.
 *
 * Mount-scoped on purpose: the caller keys the panel by session id, so a new
 * session gets a new widget and merely HIDING the panel neither disposes the
 * widget (a remounted xterm has no scrollback) nor drops the stream.
 */
export function useAgentTerminal({
  projectId,
  hostRef,
  factory = createAgentTerminal,
}: {
  projectId: string;
  hostRef: RefObject<HTMLDivElement | null>;
  factory?: AgentTerminalFactory;
}) {
  const instanceRef = useRef<AgentTerminalInstance | null>(null);

  const postResize = useCallback(
    (cols: number, rows: number) => {
      void fetch(`/api/projects/${projectId}/agent/resize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols, rows }),
      }).catch(() => {});
    },
    [projectId],
  );

  useMountEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const instance = factory();
    instance.open(host);
    instanceRef.current = instance;
    instance.onData((data) => {
      void fetch(`/api/projects/${projectId}/agent/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data }),
      }).catch(() => {});
    });
    const initial = instance.fit();
    postResize(initial.cols, initial.rows);

    if (typeof EventSource === "undefined") return () => instance.dispose();

    const source = new EventSource(`/api/projects/${projectId}/agent/stream`);
    source.addEventListener("data", (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as { data?: string };
      if (typeof payload.data === "string") instance.write(payload.data);
    });
    source.addEventListener("exit", () => {
      source.close();
      // The CLI ended on its own. The panel stays put with its final output —
      // dropping the drawer out from under a user mid-read would lose it.
      useAgentSessionStore.getState().sessionExited();
    });

    return () => {
      source.close();
      instance.dispose();
      instanceRef.current = null;
    };
  });

  /** Re-measure and tell the PTY its new winsize (a drag, or a reveal). */
  const fit = useCallback(() => {
    const instance = instanceRef.current;
    if (!instance) return;
    const { cols, rows } = instance.fit();
    postResize(cols, rows);
  }, [postResize]);

  const focus = useCallback(() => instanceRef.current?.focus(), []);

  return { fit, focus };
}
