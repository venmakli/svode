import { listen, type UnlistenFn } from "@/platform/native/events";
import { invokeCommand } from "@/platform/native/invoke";

export function invokeSettingsCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return invokeCommand<T>(command, args);
}

export function listenSettingsEvent<T>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<UnlistenFn> {
  return listen<T>(event, handler);
}
