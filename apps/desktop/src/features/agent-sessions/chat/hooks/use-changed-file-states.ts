import { useEffect, useMemo, useState } from "react";
import {
  normalizeGitStatusPath,
  refreshGitStatus,
  useGitStore,
} from "@/features/git";
import { useSpace } from "@/features/space";
import { attachmentExists } from "../api/attachments";
import {
  locateAttachment,
  type AttachmentLocation,
} from "../model/attachments";

/** How a changed file of a turn opens now. */
export interface ChangedFileState {
  /** Where it lives in the project; null outside its Spaces. */
  location: AttachmentLocation | null;
  /** It has unsaved changes in its Space. */
  dirty: boolean;
  /** Null until known. */
  exists: boolean | null;
}

/**
 * The state of the changed files at `paths` while `enabled`: their Space,
 * their unsaved changes by the Git status of the Space, and whether they
 * still exist.
 */
export function useChangedFileStates(
  paths: readonly string[],
  enabled: boolean,
): ReadonlyMap<string, ChangedFileState> {
  const rootSpaces = useSpace((state) => state.rootSpaces);
  const spaces = useSpace((state) => state.spaces);
  const statuses = useGitStore((state) => state.statuses);
  const key = paths.join("\n");
  const locations = useMemo(() => {
    const known = [...rootSpaces, ...spaces];
    return new Map(
      key
        .split("\n")
        .filter(Boolean)
        .map((path) => [path, locateAttachment(path, known)] as const),
    );
  }, [key, rootSpaces, spaces]);
  const spacePaths = [
    ...new Set(
      [...locations.values()].flatMap((location) =>
        location ? [location.spacePath] : [],
      ),
    ),
  ].join("\n");
  useEffect(() => {
    if (!enabled) return;
    for (const spacePath of spacePaths.split("\n").filter(Boolean)) {
      void refreshGitStatus(spacePath);
    }
  }, [enabled, spacePaths]);

  const dirty = new Set<string>();
  for (const [path, location] of locations) {
    const files = location ? statuses[location.spacePath]?.files : undefined;
    const relative = location ? normalizeGitStatusPath(location.path) : "";
    if (files?.some((file) => normalizeGitStatusPath(file.path) === relative)) {
      dirty.add(path);
    }
  }
  const dirtyKey = [...dirty].join("\n");

  const [existing, setExisting] = useState<{
    key: string;
    paths: ReadonlySet<string>;
  } | null>(null);
  useEffect(() => {
    if (!enabled || !key) return;
    let cancelled = false;
    const requested = key.split("\n");
    void Promise.all(
      requested.map((path) => attachmentExists(path).catch(() => false)),
    ).then((found) => {
      if (cancelled) return;
      setExisting({
        key,
        paths: new Set(requested.filter((_, index) => found[index])),
      });
    });
    return () => {
      cancelled = true;
    };
    // A file saved, restored or deleted changes the Git status: check again.
  }, [enabled, key, dirtyKey]);

  return new Map(
    [...locations].map(([path, location]) => [
      path,
      {
        location,
        dirty: dirty.has(path),
        exists: existing?.key === key ? existing.paths.has(path) : null,
      },
    ]),
  );
}
