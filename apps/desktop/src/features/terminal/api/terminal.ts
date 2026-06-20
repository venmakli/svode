import {
  killTerminal as killTerminalCommand,
  listTerminals as listTerminalSessions,
  onTerminalError as listenTerminalErrors,
  onTerminalExit as listenTerminalExits,
  onTerminalOutput as listenTerminalOutput,
  resizeTerminal as resizeTerminalSession,
  spawnTerminal as spawnTerminalSession,
  writeTerminal as writeTerminalInput,
} from "@/platform/terminal";
import type {
  TerminalErrorEvent,
  TerminalExitEvent,
  TerminalOutputEvent,
  TerminalSession,
} from "@/platform/terminal";

export type {
  TerminalErrorEvent,
  TerminalExitEvent,
  TerminalOutputEvent,
  TerminalSession,
};

export function spawnTerminal(
  cwd: string,
  cols: number,
  rows: number,
): Promise<TerminalSession> {
  return spawnTerminalSession(cwd, cols, rows);
}

export function writeTerminal(ptyId: string, data: string): Promise<void> {
  return writeTerminalInput(ptyId, data);
}

export function resizeTerminal(
  ptyId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return resizeTerminalSession(ptyId, cols, rows);
}

export function killTerminal(ptyId: string): Promise<void> {
  return killTerminalCommand(ptyId);
}

export function listTerminals(): Promise<TerminalSession[]> {
  return listTerminalSessions();
}

export function onTerminalOutput(
  handler: (event: TerminalOutputEvent) => void,
) {
  return listenTerminalOutput(handler);
}

export function onTerminalExit(handler: (event: TerminalExitEvent) => void) {
  return listenTerminalExits(handler);
}

export function onTerminalError(handler: (event: TerminalErrorEvent) => void) {
  return listenTerminalErrors(handler);
}
