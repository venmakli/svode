import { readEntry, type EntryDto } from "@/platform/entries/entries-api";
import {
  listenSpaceDirty,
  listenSpaceFileEvent,
  unwatchSpace,
  watchSpace,
  type SpaceFileEventName,
} from "@/platform/space/space-api";
import type {
  SpaceDirtyEventDto,
  SpaceFileEventDto,
} from "@/platform/space/space-types";

export type { SpaceFileEventDto, SpaceFileEventName };

export type WatchedSpaceEntry = EntryDto;

type SpaceFileEventHandler = (event: { payload: SpaceFileEventDto }) => void;
type SpaceDirtyEventHandler = (event: { payload: SpaceDirtyEventDto }) => void;

export function readWatchedSpaceEntry(
  spacePath: string,
  entryPath: string,
): Promise<EntryDto> {
  return readEntry(spacePath, entryPath);
}

export function watchSpaceFiles(spacePath: string): Promise<void> {
  return watchSpace(spacePath);
}

export function unwatchSpaceFiles(spacePath: string): Promise<void> {
  return unwatchSpace(spacePath);
}

export function listenWatchedSpaceFileEvent(
  eventName: SpaceFileEventName,
  handler: SpaceFileEventHandler,
): Promise<() => void> {
  return listenSpaceFileEvent(eventName, handler);
}

export function listenWatchedSpaceDirty(
  handler: SpaceDirtyEventHandler,
): Promise<() => void> {
  return listenSpaceDirty(handler);
}
