import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

/**
 * Thin seam over xterm.js for the agent panel.
 *
 * `AgentPanel` talks only to this interface, so a component test can inject a
 * fake: jsdom has no layout, and a real `Terminal.open()` needs measurements it
 * cannot provide.
 */

export interface AgentTerminalInstance {
  /** Attach to a host element (once). */
  open(host: HTMLElement): void;
  /** Session output into the screen buffer. */
  write(data: string): void;
  /** Keystrokes out of the widget (POSTed to the session). */
  onData(listener: (data: string) => void): void;
  /** Re-measure after a panel resize, then report the new grid. */
  fit(): { cols: number; rows: number };
  focus(): void;
  dispose(): void;
}

export type AgentTerminalFactory = () => AgentTerminalInstance;

/** Paint values mirror the studio's neutral-950 surfaces and accent. */
const XTERM_THEME = {
  background: "#0a0a0a",
  foreground: "#e5e5e5",
  cursor: "#5eead4",
  selectionBackground: "rgba(94,234,212,0.25)",
} as const;

export function createAgentTerminal(): AgentTerminalInstance {
  const terminal = new Terminal({
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: 12,
    cursorBlink: true,
    convertEol: false,
    theme: XTERM_THEME,
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  return {
    open: (host) => terminal.open(host),
    write: (data) => terminal.write(data),
    onData: (listener) => {
      terminal.onData(listener);
    },
    fit: () => {
      // A zero-sized host (a panel mid-open) makes the addon throw rather than
      // resize; the last known grid is the right answer until it has a box.
      try {
        fitAddon.fit();
      } catch {
        // Keep the previous geometry.
      }
      return { cols: terminal.cols, rows: terminal.rows };
    },
    focus: () => terminal.focus(),
    dispose: () => terminal.dispose(),
  };
}
