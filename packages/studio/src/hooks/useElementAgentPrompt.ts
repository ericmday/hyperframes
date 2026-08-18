import { useCallback, useState } from "react";
import { readTagSnippetByTarget } from "../utils/sourcePatcher";
import { toProjectAbsolutePath } from "../utils/studioHelpers";
import { buildElementAgentPrompt, type DomEditSelection } from "../components/editor/domEditing";
import { usePlayerStore } from "../player";

/**
 * The element prompt itself: the source snippet it quotes, and the one
 * composer that builds it.
 *
 * ONE composer, because the dialog has two destinations. Copy prompt and Ask
 * agent must never drift — a prompt the user pastes into their own terminal
 * has to say exactly what the agent panel would have said.
 */
export function useElementAgentPrompt({
  activeCompPath,
  projectDir,
  projectIdRef,
  domEditSelectionRef,
  domEditSelection,
}: {
  activeCompPath: string | null;
  projectDir: string | null;
  projectIdRef: React.MutableRefObject<string | null>;
  domEditSelectionRef: React.MutableRefObject<DomEditSelection | null>;
  domEditSelection: DomEditSelection | null;
}) {
  const [tagSnippet, setTagSnippet] = useState<string | undefined>();
  const [selectionContext, setSelectionContext] = useState<string | undefined>();

  /** Read the element's real source tag, which beats the runtime outerHTML. */
  const preload = useCallback(
    async (selection: DomEditSelection) => {
      const pid = projectIdRef.current;
      if (!pid) return;

      const targetPath = selection.sourceFile || activeCompPath || "index.html";
      try {
        const response = await fetch(
          `/api/projects/${pid}/files/${encodeURIComponent(targetPath)}`,
        );
        if (!response.ok) return;

        const data = (await response.json()) as { content?: string };
        const html = data.content;
        const snippet =
          typeof html === "string" ? readTagSnippetByTarget(html, selection) : undefined;

        setTagSnippet((current) => {
          if (domEditSelectionRef.current !== selection) return current;
          return snippet;
        });
      } catch {
        // Runtime outerHTML is still available as a synchronous copy fallback.
      }
    },
    [activeCompPath, domEditSelectionRef, projectIdRef],
  );

  const compose = useCallback(
    (userInstruction: string) => {
      if (!domEditSelection) return null;
      const targetPath = domEditSelection.sourceFile || activeCompPath || "index.html";
      return buildElementAgentPrompt({
        selection: domEditSelection,
        currentTime: usePlayerStore.getState().currentTime,
        tagSnippet: tagSnippet ?? domEditSelection.element.outerHTML,
        selectionContext,
        userInstruction,
        sourceFilePath: toProjectAbsolutePath(projectDir, targetPath),
        projectDir,
      });
    },
    [activeCompPath, domEditSelection, projectDir, selectionContext, tagSnippet],
  );

  const clear = useCallback(() => {
    setTagSnippet(undefined);
    setSelectionContext(undefined);
  }, []);

  return { selectionContext, setSelectionContext, preload, compose, clear };
}
