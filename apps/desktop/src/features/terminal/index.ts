export { TerminalPanelHost } from "./ui/terminal-panel-host";
export { TerminalPanelToggle } from "./ui/terminal-panel-toggle";
export { useTerminalPanelToggle } from "./hooks/use-terminal-panel-toggle";
export { useNewSpaceTerminal } from "./hooks/use-new-space-terminal";
export {
  useTerminalAgentSessionSync,
  type TerminalAgentSessionSyncOptions,
} from "./hooks/use-terminal-agent-session-sync";
export { terminalToggleShortcut } from "./model/shortcuts";
export { isTerminalKeyboardEvent } from "./lib/is-terminal-keyboard-event";
export { isTerminalToggleShortcut } from "./lib/is-terminal-toggle-shortcut";
export {
  closeManagedTerminalSurface,
  ManagedTerminalSurface,
  spawnManagedTerminalSurface,
} from "./ui/managed-terminal-surface";
