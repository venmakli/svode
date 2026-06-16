import {
  listen as tauriListen,
  once as tauriOnce,
  emit as tauriEmit,
  emitTo as tauriEmitTo,
  type Event,
  type EventCallback,
  type EventName,
  type EventTarget,
  type Options,
  type UnlistenFn,
} from "@tauri-apps/api/event";

export type {
  Event,
  EventCallback,
  EventName,
  EventTarget,
  Options,
  UnlistenFn,
};

export function listen<T>(
  event: EventName,
  handler: EventCallback<T>,
  options?: Options,
): Promise<UnlistenFn> {
  return tauriListen(event, handler, options);
}

export function once<T>(
  event: EventName,
  handler: EventCallback<T>,
  options?: Options,
): Promise<UnlistenFn> {
  return tauriOnce(event, handler, options);
}

export function emit<T>(event: string, payload?: T): Promise<void> {
  return tauriEmit(event, payload);
}

export function emitTo<T>(
  target: EventTarget | string,
  event: string,
  payload?: T,
): Promise<void> {
  return tauriEmitTo(target, event, payload);
}
