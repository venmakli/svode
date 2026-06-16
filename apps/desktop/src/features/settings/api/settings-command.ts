import {
  listen,
  type EventCallback,
  type EventName,
  type UnlistenFn,
} from "@/platform/native/events";
import { invokeCommand, type InvokeArgs } from "@/platform/native/invoke";

export function invokeSettingsCommand<T>(
  command: string,
  args?: InvokeArgs,
): Promise<T> {
  return invokeCommand<T>(command, args);
}

export function listenSettingsEvent<T>(
  event: EventName,
  handler: EventCallback<T>,
): Promise<UnlistenFn> {
  return listen<T>(event, handler);
}
