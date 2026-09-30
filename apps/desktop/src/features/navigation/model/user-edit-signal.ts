import { createContext } from "react";

/**
 * A user edit of the main area object, or an artifact the user created that
 * opens as the main area object. `spaceId` is the root id for root content.
 */
export type UserEdit =
  | { kind: "edit" }
  | { kind: "created"; spaceId: string; path: string };

type UserEditListener = (edit: UserEdit) => void;

const listeners = new Set<UserEditListener>();

/** Whether edits of the surrounding surface are edits of the main area. */
export const MainAreaEditContext = createContext(false);

export function emitUserEdit(edit: UserEdit) {
  for (const listener of listeners) listener(edit);
}

/** The one signal that keeps an object in Now; returns the unsubscribe. */
export function subscribeUserEdits(listener: UserEditListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
