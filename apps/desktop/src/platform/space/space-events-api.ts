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

/** A path a content move left and where the same content is after it. */
export interface ContentRelocationDto {
  from: string;
  to: string;
  /** A parent Page that changed form; only its own file moved. */
  converted: boolean;
}

/**
 * A content move an agent ran through Svode MCP in this app: `started`
 * before it, `finished` after it with the paths it moved, none when it
 * failed.
 */
export type ContentRelocationEventDto =
  | { space: string; phase: "started" }
  | { space: string; phase: "finished"; relocations: ContentRelocationDto[] };

export function listenContentRelocation(
  handler: (payload: ContentRelocationEventDto) => void,
): Promise<UnlistenFn> {
  return listen<ContentRelocationEventDto>("content:relocation", (event) =>
    handler(event.payload),
  );
}
