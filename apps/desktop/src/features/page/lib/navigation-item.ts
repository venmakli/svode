import {
  artifactNavigationKey,
  type NavigationItem,
} from "@/features/navigation";
import type { Page } from "../model";

/** How an open Page is pinned. `spaceId` is the root id for root content. */
export function pageNavigationItem(
  page: Page,
  spaceId: string,
  rootSpaceId: string | null,
): NavigationItem {
  return {
    key: artifactNavigationKey("page", page.path, spaceId, rootSpaceId),
    title: page.meta.title,
    ...(page.meta.icon ? { icon: page.meta.icon } : {}),
  };
}
