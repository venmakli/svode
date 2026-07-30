import { createContext, useContext } from "react";

import type { SystemCollectionDetailController } from "../model/types";
import type { SystemCollectionDetailControllerStore } from "../model/detail-controller";

const SystemCollectionDetailStoreContext =
  createContext<SystemCollectionDetailControllerStore | null>(null);

export const SystemCollectionDetailStoreProvider =
  SystemCollectionDetailStoreContext.Provider;

export function useSystemCollectionDetailController(): SystemCollectionDetailController {
  return useSystemCollectionDetailStore().controller;
}

export function useOptionalSystemCollectionDetailController(): SystemCollectionDetailController | null {
  return useContext(SystemCollectionDetailStoreContext)?.controller ?? null;
}

export function useSystemCollectionDetailStore(): SystemCollectionDetailControllerStore {
  const store = useContext(SystemCollectionDetailStoreContext);
  if (!store) {
    throw new Error(
      "System Collection detail requires the app-shell Drawer provider",
    );
  }
  return store;
}
