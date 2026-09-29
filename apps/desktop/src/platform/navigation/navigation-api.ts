import { invokeCommand } from "@/platform/native/invoke";
import { listen, type UnlistenFn } from "@/platform/native/events";

/** Desktop moved or dropped pins after an in-app change of artifact paths. */
const NAVIGATION_CHANGED_EVENT = "navigation:changed";

/** Artifacts are keyed by registered Space id; no `spaceId` is the Project root. */
export type NavigationKeyDto =
  | { kind: "space"; spaceId?: string }
  | {
      kind: "page" | "collection" | "attachment" | "app";
      spaceId?: string;
      path: string;
    }
  | { kind: "session"; sessionId: string }
  | { kind: "sessionLaunch"; launchId: string };

export interface NavigationItemDto {
  key: NavigationKeyDto;
  title: string;
  icon?: string;
}

/**
 * A pinned item as resolved by Desktop. `available` is absent for sessions,
 * which the session catalog resolves; `openPath` is the path an available
 * artifact opens by.
 */
export interface NavigationPinnedItemDto extends NavigationItemDto {
  available?: boolean;
  openPath?: string;
}

export interface NavigationStateDto {
  pinned: NavigationPinnedItemDto[];
}

export function listenNavigationChanged(
  handler: () => void,
): Promise<UnlistenFn> {
  return listen<void>(NAVIGATION_CHANGED_EVENT, () => handler());
}

export function readNavigationState(
  projectPath: string,
): Promise<NavigationStateDto> {
  return invokeCommand<NavigationStateDto>("navigation_read", { projectPath });
}

export function pinNavigationItem(
  projectPath: string,
  item: NavigationItemDto,
): Promise<NavigationStateDto> {
  return invokeCommand<NavigationStateDto>("navigation_pin", {
    projectPath,
    item,
  });
}

export function forgetNavigationItems(
  projectPath: string,
  keys: NavigationKeyDto[],
): Promise<NavigationStateDto> {
  return invokeCommand<NavigationStateDto>("navigation_forget", {
    projectPath,
    keys,
  });
}

export function getNavigationExpandedPaths(space: string): Promise<string[]> {
  return invokeCommand<string[]>("navigation_expanded_paths", { space });
}

export function saveNavigationExpandedPaths(
  space: string,
  paths: string[],
): Promise<void> {
  return invokeCommand<void>("navigation_save_expanded_paths", {
    space,
    paths,
  });
}
