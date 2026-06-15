import { invokeCommand as invoke } from "@/platform/native/invoke";
import { listen, type UnlistenFn } from "@/platform/native/events";

export interface TerminalSession {
  ptyId: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
}

export interface TerminalOutputEvent {
  ptyId: string;
  data: string;
}

export interface TerminalExitEvent {
  ptyId: string;
}

export interface TerminalErrorEvent {
  ptyId: string;
  message: string;
}

export function spawnTerminal(
  cwd: string,
  cols: number,
  rows: number,
): Promise<TerminalSession> {
  return invoke<TerminalSession>("terminal_spawn", { cwd, cols, rows });
}

export function writeTerminal(ptyId: string, data: string): Promise<void> {
  return invoke("terminal_write", { ptyId, data });
}

export function resizeTerminal(
  ptyId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("terminal_resize", { ptyId, cols, rows });
}

export function killTerminal(ptyId: string): Promise<void> {
  return invoke("terminal_kill", { ptyId });
}

export function listTerminals(): Promise<TerminalSession[]> {
  return invoke<TerminalSession[]>("terminal_list");
}

export function onTerminalOutput(
  handler: (event: TerminalOutputEvent) => void,
): Promise<UnlistenFn> {
  return listen<TerminalOutputEvent>("terminal:output", (event) => {
    handler(event.payload);
  });
}

export function onTerminalExit(
  handler: (event: TerminalExitEvent) => void,
): Promise<UnlistenFn> {
  return listen<TerminalExitEvent>("terminal:exit", (event) => {
    handler(event.payload);
  });
}

export function onTerminalError(
  handler: (event: TerminalErrorEvent) => void,
): Promise<UnlistenFn> {
  return listen<TerminalErrorEvent>("terminal:error", (event) => {
    handler(event.payload);
  });
}
