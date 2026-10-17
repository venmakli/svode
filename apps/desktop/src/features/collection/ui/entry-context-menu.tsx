import { createContext, useContext, type ReactNode } from "react";
import {
  ContentActionMenuItems,
  contentActionGroups,
  pageFormOfPath,
} from "@/features/content-actions";
import type { Page } from "@/features/page";
import { usePageFolderContents } from "@/features/space";
import type { CollectionEntryMenu } from "../model";

const CollectionEntryMenuContext = createContext<CollectionEntryMenu | null>(
  null,
);

export function CollectionEntryMenuProvider({
  value,
  children,
}: {
  value: CollectionEntryMenu;
  children: ReactNode;
}) {
  return (
    <CollectionEntryMenuContext.Provider value={value}>
      {children}
    </CollectionEntryMenuContext.Provider>
  );
}

function useCollectionEntryMenu(): CollectionEntryMenu {
  const menu = useContext(CollectionEntryMenuContext);
  if (!menu) {
    throw new Error("Collection rows need a CollectionEntryMenuProvider");
  }
  return menu;
}

/**
 * The context menu items of a Collection row: "Open in peek" and then the
 * item's menu from the content action catalog, mounted while the menu is open.
 * An item with its own schema is a Collection, as in its Peek and the sidebar.
 */
export function CollectionEntryContextMenuItems({
  entry,
  nestedCollection = false,
  onOpenInPeek,
}: {
  entry: Page;
  nestedCollection?: boolean;
  onOpenInPeek: () => void;
}) {
  const menu = useCollectionEntryMenu();
  const form = pageFormOfPath(entry.path);
  const contents = usePageFolderContents(
    menu.spacePath,
    form === "folder" && !nestedCollection ? entry.path : null,
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
      pinItem={menu.pinItem(entry)}
      handlers={{ ...menu.handlers(entry), "open-in-peek": onOpenInPeek }}
    />
  );
}
