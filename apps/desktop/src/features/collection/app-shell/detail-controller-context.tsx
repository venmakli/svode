import { createContext, useContext } from "react";

import type { CollectionDetailControllerStore } from "./detail-controller";
import type { CollectionDetailController } from "./types";

const CollectionDetailStoreContext =
  createContext<CollectionDetailControllerStore | null>(null);

export const CollectionDetailStoreProvider =
  CollectionDetailStoreContext.Provider;

export function useCollectionDetailController(): CollectionDetailController {
  return useCollectionDetailStore().controller;
}

export function useOptionalCollectionDetailController(): CollectionDetailController | null {
  return useContext(CollectionDetailStoreContext)?.controller ?? null;
}

export function useCollectionDetailStore(): CollectionDetailControllerStore {
  const store = useContext(CollectionDetailStoreContext);
  if (!store) {
    throw new Error("Collection detail requires the app-shell Drawer provider");
  }
  return store;
}
