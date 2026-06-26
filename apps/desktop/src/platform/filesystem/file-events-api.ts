import { listen, type UnlistenFn } from "@/platform/native/events";

export type { UnlistenFn };

export interface FileEventDto {
  space?: string;
  path: string;
}

type FileEventHandler = (payload: FileEventDto) => void;

export function listenFileCreated(
  handler: FileEventHandler,
): Promise<UnlistenFn> {
  return listen<FileEventDto>("file:created", (event) =>
    handler(event.payload),
  );
}

export function listenFileChanged(
  handler: FileEventHandler,
): Promise<UnlistenFn> {
  return listen<FileEventDto>("file:changed", (event) =>
    handler(event.payload),
  );
}

export function listenFileDeleted(
  handler: FileEventHandler,
): Promise<UnlistenFn> {
  return listen<FileEventDto>("file:deleted", (event) =>
    handler(event.payload),
  );
}
