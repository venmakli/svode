import { useEffect, useState } from "react";
import { readGitConflictKinds } from "../api/git-conflict-actions";
import type { GitConflictKind, GitStatus } from "../model";

/**
 * The kinds of the conflicted paths of `status`, the status of `spacePath`,
 * by their paths relative to it; read again whenever its conflicts change.
 */
export function useGitConflictKinds(
  spacePath: string,
  status: GitStatus | undefined,
): ReadonlyMap<string, GitConflictKind> {
  const conflicts = (status?.files ?? [])
    .filter((file) => file.state === "conflict")
    .map((file) => file.path)
    .sort()
    .join("\0");
  const [kinds, setKinds] = useState<{
    key: string;
    kinds: ReadonlyMap<string, GitConflictKind>;
  } | null>(null);
  const key = `${spacePath}\0\0${conflicts}`;
  useEffect(() => {
    if (!conflicts) return;
    let active = true;
    readGitConflictKinds(spacePath).then(
      (files) => {
        if (active)
          setKinds({
            key,
            kinds: new Map(files.map((file) => [file.path, file.kind])),
          });
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [conflicts, key, spacePath]);
  return kinds?.key === key ? kinds.kinds : EMPTY;
}

const EMPTY: ReadonlyMap<string, GitConflictKind> = new Map();
