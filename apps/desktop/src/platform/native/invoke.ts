import {
  Channel,
  convertFileSrc as tauriConvertFileSrc,
  invoke as tauriInvoke,
  type InvokeArgs,
  type InvokeOptions,
} from "@tauri-apps/api/core";

export type { InvokeArgs, InvokeOptions };

/** Ordered stream of messages from one command to its caller. */
export { Channel as NativeChannel };

export function invokeCommand<T>(
  command: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
): Promise<T> {
  return tauriInvoke<T>(command, args, options);
}

export { invokeCommand as invoke };

export function convertFileSrc(filePath: string, protocol?: string): string {
  return tauriConvertFileSrc(filePath, protocol);
}
