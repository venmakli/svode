import { createContext, useContext } from "react";

/** A file of a project Space whose unsaved changes to show. */
export interface FileChangesTarget {
  spacePath: string;
  /** Relative to the Space. */
  path: string;
  name: string;
}

/**
 * Opens the "Changes" window of one file (Stage 10 `08` R2, changed files
 * of a turn); the app shell owns the window.
 */
export type OpenFileChanges = (target: FileChangesTarget) => void;

export const ChangesOpenerContext = createContext<OpenFileChanges | null>(null);

export function useOpenFileChanges(): OpenFileChanges | null {
  return useContext(ChangesOpenerContext);
}
