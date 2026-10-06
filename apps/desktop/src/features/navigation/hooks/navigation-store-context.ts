import { createContext } from "react";
import type { NavigationStore } from "../model/navigation-store";

/**
 * The navigation state of another project than the open one, for the
 * controls rendered under it; the open project's state otherwise.
 */
export const NavigationStoreContext = createContext<NavigationStore | null>(
  null,
);
