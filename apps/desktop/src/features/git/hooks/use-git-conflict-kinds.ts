import { useEffect, useState } from "react";
import { readGitConflictKinds } from "../api/git-conflict-actions";
import type { GitConflictKind, GitStatus } from "../model";
import { conflictPartners } from "../model/conflict-paths";

/**
 * The kinds of the conflicted paths of a status, by their paths, and the
 * paths a list shows with another path of their conflict instead of on
 * their own.
 */
export interface GitConflictKinds {
  kinds: ReadonlyMap<string, GitConflictKind>;
  partners: ReadonlySet<string>;
}

/**
 * The kinds of the conflicted paths of `status`, the status of `spacePath`,
 * by their paths relative to it; read again whenever its conflicts change.
 */
export function useGitConflictKinds(
  spacePath: string,
  status: GitStatus | undefined,
): GitConflictKinds {
  const conflicts = (status?.files ?? [])
    .filter((file) => file.state === "conflict")
    .map((file) => file.path)
    .sort()
    .join("\0");
  const [kinds, setKinds] = useState<{
    key: string;
    kinds: GitConflictKinds;
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
            kinds: {
              kinds: new Map(files.map((file) => [file.path, file.kind])),
              partners: conflictPartners(files),
            },
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

const EMPTY: GitConflictKinds = { kinds: new Map(), partners: new Set() };
