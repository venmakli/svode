import type { ReactNode } from "react";
import { NavigationStoreContext } from "../hooks/navigation-store-context";
import type { NavigationStore } from "../model/navigation-store";

/** Binds the navigation controls inside to another project's state. */
export function NavigationStoreProvider({
  store,
  children,
}: {
  store: NavigationStore;
  children: ReactNode;
}) {
  return (
    <NavigationStoreContext.Provider value={store}>
      {children}
    </NavigationStoreContext.Provider>
  );
}
