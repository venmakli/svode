export { TerminalPanelHost } from "./ui/terminal-panel-host";
export { TerminalPrimaryAction } from "./ui/terminal-primary-action";
export { useTerminalStore } from "./hooks/use-terminal-store";
export { isTerminalKeyboardEvent } from "./lib/is-terminal-keyboard-event";
export {
  buildProjectTerminalTarget,
  buildSpaceTerminalTargets,
} from "./lib/targets";
export type { TerminalTab, TerminalTarget } from "./model/types";
