import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import {
  useAgentSessionStore,
  AGENT_PANEL_MAX_WIDTH,
  AGENT_PANEL_MIN_WIDTH,
  type AgentSessionInfo,
} from "../hooks/agentSessionStore";
import { useAgentTerminal } from "../hooks/useAgentTerminal";
import type { AgentTerminalFactory } from "../utils/xtermTerminal";

/**
 * The Claude panel: the right-hand drawer the element dialog talks into.
 *
 * ONE session, kept across asks, so a follow-up lands in a conversation that
 * already knows the project — that is the whole difference from copying a
 * prompt into a terminal.
 *
 * Hiding (–) leaves the CLI running and the scrollback intact, because the
 * agent is usually mid-turn when the user goes back to the canvas; the drawer
 * stays MOUNTED while hidden for the same reason (a remounted xterm is a blank
 * screen). Ending it (×) kills the process.
 */
function AgentDrawer({
  projectId,
  session,
  factory,
}: {
  projectId: string;
  session: AgentSessionInfo;
  factory?: AgentTerminalFactory;
}) {
  const panelOpen = useAgentSessionStore((s) => s.panelOpen);
  const panelWidth = useAgentSessionStore((s) => s.panelWidth);
  const setPanelOpen = useAgentSessionStore((s) => s.setPanelOpen);
  const setPanelWidth = useAgentSessionStore((s) => s.setPanelWidth);
  const endSession = useAgentSessionStore((s) => s.endSession);

  const hostRef = useRef<HTMLDivElement>(null);
  const { fit, focus } = useAgentTerminal({
    projectId,
    hostRef,
    ...(factory ? { factory } : {}),
  });

  // The CLI's UI lays itself out to the winsize, so every width change has to
  // reach the PTY. Done in the gesture rather than in an effect on width.
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const move = (moveEvent: PointerEvent) => {
      setPanelWidth(window.innerWidth - moveEvent.clientX);
      fit();
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      fit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  return (
    <div
      hidden={!panelOpen}
      aria-label="Agent panel"
      style={{ width: `${panelWidth}px` }}
      className="absolute inset-y-0 right-0 z-[95] flex flex-col border-l border-neutral-800 bg-neutral-950"
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-neutral-800/60 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-300">
          {session.title}
        </span>
        <button
          className="rounded-md px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-800/50 hover:text-neutral-300"
          aria-label="Hide agent panel"
          title="Hide — the session keeps running"
          onClick={() => setPanelOpen(false)}
        >
          –
        </button>
        <button
          className="rounded-md px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-800/50 hover:text-neutral-300"
          aria-label="End agent session"
          title="End the session"
          onClick={() => void endSession(projectId)}
        >
          ×
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          role="separator"
          aria-label="Resize agent panel"
          aria-orientation="vertical"
          aria-valuenow={panelWidth}
          aria-valuemin={AGENT_PANEL_MIN_WIDTH}
          aria-valuemax={AGENT_PANEL_MAX_WIDTH}
          onPointerDown={startResize}
          className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize hover:bg-studio-accent/40"
        />
        <div
          ref={hostRef}
          data-hf-agent-terminal={session.id}
          onClick={focus}
          className="h-full w-full overflow-hidden p-2"
        />
      </div>
    </div>
  );
}

export function AgentPanel({
  projectId,
  factory,
}: {
  projectId: string;
  factory?: AgentTerminalFactory;
}) {
  const session = useAgentSessionStore((s) => s.session);
  const panelOpen = useAgentSessionStore((s) => s.panelOpen);
  const setPanelOpen = useAgentSessionStore((s) => s.setPanelOpen);

  if (!session) return null;

  return (
    <>
      {/* A hidden panel is still a running agent, so there has to be a way
          back to it that is not "ask it something else". */}
      {!panelOpen && (
        <button
          aria-label="Show agent panel"
          onClick={() => setPanelOpen(true)}
          className="absolute right-0 top-1/2 z-[95] -translate-y-1/2 rounded-l-md border border-r-0 border-neutral-800 bg-neutral-950 px-1 py-3 text-[10px] font-medium text-neutral-400 [writing-mode:vertical-rl] hover:text-neutral-200"
        >
          Claude
        </button>
      )}
      {/* Keyed by session: a new CLI gets a new widget, and hiding the panel
          keeps this one alive with its scrollback. */}
      <AgentDrawer
        key={session.id}
        projectId={projectId}
        session={session}
        {...(factory ? { factory } : {})}
      />
    </>
  );
}
