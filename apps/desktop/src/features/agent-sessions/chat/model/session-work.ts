import { create } from "zustand";
import type { ChangesTarget } from "@/features/changes";
import { locateAttachment } from "./attachments";
import { turnChanges } from "./changed-files";
import type { TimelineTurn } from "./timeline";

/**
 * The work of a chat session (Stage 11 1.7, "Changes" of the session): the
 * files the rows "Changed files" of all its turns name, without repeats, in
 * order of first appearance. A pure function of the projection, so a replay
 * and a reopened session give the same work.
 */
export function sessionWorkFiles(turns: readonly TimelineTurn[]): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const turn of turns) {
    for (const file of turnChanges(turn)?.files ?? []) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      files.push(file.path);
    }
  }
  return files;
}

/**
 * The "Changes" target of a session's Space: with the work a chat shows, the
 * area of that work in the project's Spaces — files outside them are no part
 * of it; without (a terminal session), the Space itself.
 */
export function sessionChangesTarget(
  space: ChangesTarget,
  work: readonly string[] | null,
  spaces: readonly { id: string; path: string }[],
): ChangesTarget {
  if (!work) return space;
  const files = work.flatMap((path) => {
    const location = locateAttachment(path, spaces);
    return location ? [location] : [];
  });
  return {
    ...space,
    kind: "session",
    work: { files, spaceKind: space.kind === "project" ? "project" : "space" },
  };
}

interface SessionWorkState {
  /** Work files by catalogue session id, while a chat shows the session. */
  files: Record<string, readonly string[]>;
  holders: Record<string, number>;
}

/** Runtime only: the work lives while a chat shows its session. */
export const useSessionWorkStore = create<SessionWorkState>(() => ({
  files: {},
  holders: {},
}));

/** A chat starts showing the session; the returned release ends it. */
export function holdSessionWork(sessionId: string): () => void {
  useSessionWorkStore.setState((state) => ({
    holders: {
      ...state.holders,
      [sessionId]: (state.holders[sessionId] ?? 0) + 1,
    },
  }));
  return () =>
    useSessionWorkStore.setState((state) => {
      const left = (state.holders[sessionId] ?? 1) - 1;
      if (left > 0) return { holders: { ...state.holders, [sessionId]: left } };
      const holders = { ...state.holders };
      const files = { ...state.files };
      delete holders[sessionId];
      delete files[sessionId];
      return { holders, files };
    });
}

export function publishSessionWork(
  sessionId: string,
  files: readonly string[],
) {
  useSessionWorkStore.setState((state) => ({
    files: { ...state.files, [sessionId]: files },
  }));
}
