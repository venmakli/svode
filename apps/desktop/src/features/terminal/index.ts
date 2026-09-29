export { TerminalPanelHost } from "./ui/terminal-panel-host";
export { TerminalSidebarAction } from "./ui/terminal-sidebar-action";
export { useTerminalPanelToggle } from "./hooks/use-terminal-panel-toggle";
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
