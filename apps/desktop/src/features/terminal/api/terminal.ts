import {
  killTerminal as killTerminalCommand,
  listAgentTerminalSurfaces as listAgentTerminalSurfaceSessions,
  listTerminals as listTerminalSessions,
  onTerminalError as listenTerminalErrors,
  onTerminalExit as listenTerminalExits,
  onTerminalOutput as listenTerminalOutput,
  registerAgentTerminalSession as registerAgentTerminalSessionCommand,
  resizeTerminal as resizeTerminalSession,
  spawnTerminal as spawnTerminalSession,
  writeTerminal as writeTerminalInput,
} from "@/platform/terminal";
import type {
  RegisterAgentTerminalSessionInput,
  TerminalAgentSurfaceSession,
  TerminalErrorEvent,
  TerminalExitEvent,
  TerminalOutputEvent,
  TerminalSession,
} from "@/platform/terminal";
import type { TerminalAgentSurface } from "@/features/terminal/model/types";

export type {
  TerminalErrorEvent,
  TerminalExitEvent,
  TerminalOutputEvent,
  TerminalSession,
  RegisterAgentTerminalSessionInput,
  TerminalAgentSurfaceSession,
};

export function spawnTerminal(
  cwd: string,
  cols: number,
  rows: number,
  mcpProjectPath?: string | null,
): Promise<TerminalSession> {
  return spawnTerminalSession(cwd, cols, rows, mcpProjectPath);
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

export function listAgentTerminalSurfaces(): Promise<TerminalAgentSurface[]> {
  return listAgentTerminalSurfaceSessions();
}

export function registerAgentTerminalSession(
  input: RegisterAgentTerminalSessionInput,
): Promise<void> {
  return registerAgentTerminalSessionCommand(input);
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
