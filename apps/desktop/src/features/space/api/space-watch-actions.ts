import { readPage } from "@/platform/pages/pages-api";
import {
  listenSpaceDirty,
  listenSpaceFileEvent,
  unwatchSpace,
  watchSpace,
} from "@/platform/space/space-api";
import type {
  SpaceDirtyEvent,
  SpaceFileEvent,
  SpaceFileEventName,
  WatchedSpacePage,
} from "../model/space-watch-events";

type SpaceFileEventHandler = (event: { payload: SpaceFileEvent }) => void;
type SpaceDirtyEventHandler = (event: { payload: SpaceDirtyEvent }) => void;

export function readWatchedSpacePage(
  spacePath: string,
  pagePath: string,
): Promise<WatchedSpacePage> {
  return readPage(spacePath, pagePath);
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
  return listenSpaceFileEvent(eventName, (event) =>
    handler({ payload: event.payload }),
  );
}

export function listenWatchedSpaceDirty(
  handler: SpaceDirtyEventHandler,
): Promise<() => void> {
  return listenSpaceDirty((event) => handler({ payload: event.payload }));
}
