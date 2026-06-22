export type SpaceFileEventName =
  | "file:created"
  | "file:changed"
  | "file:deleted";

export type SpaceFileEventKind = "document" | "schema" | "folder" | "unknown";

export interface SpaceFileEvent {
  space?: string;
  path: string;
  kind?: SpaceFileEventKind;
  isDir?: boolean;
  parentPath?: string | null;
  affectsTree?: boolean;
  affectsMetadata?: boolean;
  writeNonce?: string;
}

export interface SpaceDirtyEvent {
  space: string;
  affectsTree?: boolean;
}

export interface WatchedSpaceEntry {
  meta: {
    title: string;
    icon: string | null;
    description?: string | null;
  };
}
