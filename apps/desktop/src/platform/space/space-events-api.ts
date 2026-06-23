import { listen, type UnlistenFn } from "@/platform/native/events";

export interface SpaceSyncedEventDto {
  projectPath?: string;
  spacePath?: string;
  path?: string;
}

export function listenSpaceSynced(
  handler: (payload: SpaceSyncedEventDto) => void,
): Promise<UnlistenFn> {
  return listen<SpaceSyncedEventDto>("space:synced", (event) =>
    handler(event.payload),
  );
}
