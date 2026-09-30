import type { ReactNode } from "react";
import { MainAreaEditContext } from "../model/user-edit-signal";

/**
 * Marks whether user edits inside are edits of the main area object: the
 * main area sets it, a peek resets it for everything it shows.
 */
export function UserEditScope({
  mainArea,
  children,
}: {
  mainArea: boolean;
  children: ReactNode;
}) {
  return (
    <MainAreaEditContext.Provider value={mainArea}>
      {children}
    </MainAreaEditContext.Provider>
  );
}
