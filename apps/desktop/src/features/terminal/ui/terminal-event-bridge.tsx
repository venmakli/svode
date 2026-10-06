import { useTerminalEventBridge } from "../hooks/use-terminal-event-bridge";

/**
 * Feeds PTY events to session terminals where the shell has no terminal
 * panel, which otherwise runs the bridge.
 */
export function TerminalEventBridge() {
  useTerminalEventBridge();
  return null;
}
