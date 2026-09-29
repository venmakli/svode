import { invokeCommand } from "@/platform/native/invoke";

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

export interface NavigationStateDto {
  pinned: NavigationItemDto[];
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
