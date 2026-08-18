import { useState, useCallback, useRef, useEffect } from "react";
import { copyTextToClipboard } from "../utils/clipboard";
import { type AgentModalAnchorPoint } from "../utils/studioHelpers";
import { type DomEditSelection } from "../components/editor/domEditing";
import { useAgentSessionStore } from "./agentSessionStore";
import { useElementAgentPrompt } from "./useElementAgentPrompt";

// ── Types ──

export interface UseAskAgentModalParams {
  projectId: string | null;
  activeCompPath: string | null;
  projectDir: string | null;
  projectIdRef: React.MutableRefObject<string | null>;
  showToast: (message: string, tone?: "error" | "info") => void;
  domEditSelectionRef: React.MutableRefObject<DomEditSelection | null>;
  domEditSelection: DomEditSelection | null;
}

// ── Hook ──

export function useAskAgentModal({
  activeCompPath,
  projectDir,
  projectIdRef,
  showToast,
  domEditSelectionRef,
  domEditSelection,
}: UseAskAgentModalParams) {
  // ── State ──

  const [agentModalAnchorPoint, setAgentModalAnchorPoint] = useState<AgentModalAnchorPoint | null>(
    null,
  );
  const [copiedAgentPrompt, setCopiedAgentPrompt] = useState(false);
  const [agentModalOpen, setAgentModalOpen] = useState(false);

  const {
    selectionContext: agentPromptSelectionContext,
    setSelectionContext: setAgentPromptSelectionContext,
    preload: preloadAgentPromptSnippet,
    compose: composePrompt,
    clear: clearAgentPrompt,
  } = useElementAgentPrompt({
    activeCompPath,
    projectDir,
    projectIdRef,
    domEditSelectionRef,
    domEditSelection,
  });

  // ── Refs ──

  const copiedAgentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Callbacks ──

  const handleAskAgent = useCallback(() => {
    if (!domEditSelection) return;
    clearAgentPrompt();
    setAgentModalAnchorPoint(null);
    void preloadAgentPromptSnippet(domEditSelection);
    setAgentModalOpen(true);
  }, [clearAgentPrompt, domEditSelection, preloadAgentPromptSnippet]);

  /** Everything a sent prompt does to the dialog, whichever way it went out. */
  const closeAfterSend = useCallback(() => {
    setAgentModalOpen(false);
    setAgentPromptSelectionContext(undefined);
    setAgentModalAnchorPoint(null);
  }, [setAgentPromptSelectionContext]);

  const handleAgentModalSubmit = useCallback(
    async (userInstruction: string) => {
      const prompt = composePrompt(userInstruction);
      if (prompt === null) return;

      const copied = await copyTextToClipboard(prompt);
      if (!copied) {
        showToast("Could not copy prompt to clipboard.", "error");
        return;
      }

      closeAfterSend();
      if (copiedAgentTimerRef.current) clearTimeout(copiedAgentTimerRef.current);
      setCopiedAgentPrompt(true);
      copiedAgentTimerRef.current = setTimeout(() => setCopiedAgentPrompt(false), 1600);
    },
    [closeAfterSend, composePrompt, showToast],
  );

  /**
   * Send the same prompt into the agent panel instead of the clipboard.
   *
   * The first ask starts the session; every one after is a follow-up into the
   * SAME one, which is the point — the agent keeps what it has already read
   * about the project. The dialog closes only on success, so a missing CLI
   * leaves the typed request (and Copy prompt) where the user can still use it.
   */
  const handleAgentModalAsk = useCallback(
    async (userInstruction: string) => {
      const prompt = composePrompt(userInstruction);
      const pid = projectIdRef.current;
      if (prompt === null || !pid) return;

      if (await useAgentSessionStore.getState().ask(pid, prompt)) closeAfterSend();
    },
    [closeAfterSend, composePrompt, projectIdRef],
  );

  // ── Effects ──

  // Clear agent-prompt state when selection changes
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    clearAgentPrompt();
    setAgentModalAnchorPoint(null);
    setCopiedAgentPrompt(false);
    // clearAgentPrompt is stable (no deps of its own); listed to satisfy the
    // hooks rule without widening what actually retriggers this.
  }, [clearAgentPrompt, domEditSelection]);

  // Cleanup copiedAgentTimerRef
  // eslint-disable-next-line no-restricted-syntax
  useEffect(
    () => () => {
      if (copiedAgentTimerRef.current) clearTimeout(copiedAgentTimerRef.current);
    },
    [],
  );

  return {
    // State
    agentModalOpen,
    agentModalAnchorPoint,
    copiedAgentPrompt,
    agentPromptSelectionContext,

    // Setters (consumed by handlePreviewCanvasMouseDown and other callers)
    setAgentModalOpen,
    setAgentPromptSelectionContext,
    setAgentModalAnchorPoint,

    // Callbacks
    preloadAgentPromptSnippet,
    handleAskAgent,
    handleAgentModalSubmit,
    handleAgentModalAsk,
  };
}
