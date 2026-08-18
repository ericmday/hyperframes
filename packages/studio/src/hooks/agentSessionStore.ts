import { create } from "zustand";

/**
 * The "Ask agent" panel: one Claude Code session per served project, run by
 * the studio server and drawn into the right-hand drawer.
 *
 * It is the SESSION that persists — a second ask writes a follow-up into the
 * running CLI instead of starting a new one, which is the whole reason the
 * panel exists over the clipboard (the agent keeps everything it has already
 * read about the project). Hiding the panel leaves the CLI running, because
 * the agent is usually mid-turn when the user goes back to the canvas; ending
 * it is an explicit act.
 *
 * The xterm instance itself is a DOM object owned by `AgentPanel`, not state.
 */

/** Width the panel opens at, as a fraction of the window. */
const AGENT_PANEL_WIDTH_FRACTION = 0.4;
export const AGENT_PANEL_MIN_WIDTH = 360;
export const AGENT_PANEL_MAX_WIDTH = 1200;

export interface AgentSessionInfo {
  id: string;
  title: string;
  cwd: string;
  pid: number | null;
}

interface AgentSessionState {
  /** Live session, or null when none is running. */
  session: AgentSessionInfo | null;
  /** Panel visible; the session outlives hiding it. */
  panelOpen: boolean;
  panelWidth: number;
  /** An ask is in flight — the dialog's buttons wait for it. */
  sending: boolean;
  /** Last failure, shown in the dialog (a missing CLI, mostly). */
  error: string | null;

  /**
   * Send one request: start the session on the first ask, follow up on every
   * one after. Answers false when nothing was sent (`error` says why).
   */
  ask: (projectId: string, message: string) => Promise<boolean>;
  /** Kill the CLI and close the panel (the × / End session). */
  endSession: (projectId: string) => Promise<void>;
  setPanelOpen: (open: boolean) => void;
  setPanelWidth: (width: number) => void;
  /** The CLI exited on its own — drop the session, leave the panel be. */
  sessionExited: () => void;
  clearError: () => void;
}

function defaultPanelWidth(): number {
  const width = typeof window === "undefined" ? 1280 : window.innerWidth;
  return Math.min(
    AGENT_PANEL_MAX_WIDTH,
    Math.max(AGENT_PANEL_MIN_WIDTH, Math.round(width * AGENT_PANEL_WIDTH_FRACTION)),
  );
}

function clampWidth(width: number): number {
  return Math.min(AGENT_PANEL_MAX_WIDTH, Math.max(AGENT_PANEL_MIN_WIDTH, Math.round(width)));
}

export const useAgentSessionStore = create<AgentSessionState>((set, get) => ({
  session: null,
  panelOpen: false,
  panelWidth: defaultPanelWidth(),
  sending: false,
  error: null,

  ask: async (projectId, message) => {
    set({ sending: true, error: null });
    try {
      const response = await fetch(`/api/projects/${projectId}/agent/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        session?: AgentSessionInfo;
        message?: string;
        error?: string;
      };
      if (!response.ok || !data.session) {
        set({
          sending: false,
          error: data.message ?? data.error ?? "Could not reach the agent.",
        });
        return false;
      }
      set({ session: data.session, panelOpen: true, sending: false });
      return true;
    } catch {
      set({ sending: false, error: "Could not reach the studio server." });
      return false;
    }
  },

  endSession: async (projectId) => {
    // Closed either way: a session the server has already lost is still gone.
    await fetch(`/api/projects/${projectId}/agent/close`, { method: "POST" }).catch(() => {});
    set({ session: null, panelOpen: false });
  },

  setPanelOpen: (panelOpen) => set({ panelOpen }),
  setPanelWidth: (width) => set({ panelWidth: clampWidth(width) }),
  sessionExited: () => {
    if (!get().session) return;
    set({ session: null });
  },
  clearError: () => set({ error: null }),
}));
