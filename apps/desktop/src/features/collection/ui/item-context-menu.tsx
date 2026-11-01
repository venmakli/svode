import { createContext, useContext, type ReactNode } from "react";
import {
  ContentActionMenuItems,
  contentActionGroups,
  pageFormOfPath,
} from "@/features/content-actions";
import type { Page } from "@/features/page";
import { usePageFolderContents } from "@/features/space";
import type { CollectionItemMenu } from "../model";

const CollectionItemMenuContext = createContext<CollectionItemMenu | null>(
  null,
);

export function CollectionItemMenuProvider({
  value,
  children,
}: {
  value: CollectionItemMenu;
  children: ReactNode;
}) {
  return (
    <CollectionItemMenuContext.Provider value={value}>
      {children}
    </CollectionItemMenuContext.Provider>
  );
}

function useCollectionItemMenu(): CollectionItemMenu {
  const menu = useContext(CollectionItemMenuContext);
  if (!menu) {
    throw new Error("Collection items need a CollectionItemMenuProvider");
  }
  return menu;
}

/**
 * The context menu items of a Collection item: "Open in peek" and then the
 * item's menu from the content action catalog, mounted while the menu is open.
 * An item with its own schema is a Collection, as in its Peek and the sidebar.
 */
export function CollectionItemContextMenuItems({
  item,
  nestedCollection = false,
  onOpenInPeek,
}: {
  item: Page;
  nestedCollection?: boolean;
  onOpenInPeek: () => void;
}) {
  const menu = useCollectionItemMenu();
  const form = pageFormOfPath(item.path);
  const contents = usePageFolderContents(
    menu.spacePath,
    form === "folder" && !nestedCollection ? item.path : null,
  );
  const groups = contentActionGroups({
    object: nestedCollection
      ? { kind: "collection" }
      : { kind: "collection-item", form, contents },
    readOnly: menu.readOnly,
    surfaceActions: { openInPeek: true },
  });
  return (
    <ContentActionMenuItems
      menu="context"
      groups={groups}
      pinItem={menu.pinItem(item)}
      handlers={{ ...menu.handlers(item), "open-in-peek": onOpenInPeek }}
    />
  );
}
