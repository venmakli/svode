import { useCallback, useContext } from "react";
import { emitUserEdit, MainAreaEditContext } from "../model/user-edit-signal";

/**
 * Reports a user edit of the surface it is called in. Only edits inside the
 * main area count; a peek or any other host reports nothing.
 */
export function useSignalUserEdit(): () => void {
  const mainArea = useContext(MainAreaEditContext);
  return useCallback(() => {
    if (mainArea) emitUserEdit({ kind: "edit" });
  }, [mainArea]);
}

/**
 * Reports an artifact the user created and opened as the main area object.
 * It is kept once the main area shows it, wherever the creation started.
 */
export function signalCreatedArtifact(spaceId: string, path: string) {
  emitUserEdit({ kind: "created", spaceId, path });
}
