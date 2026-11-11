import { useEffect, useMemo, useRef, useState } from "react";
import {
  gitStatusFileAt,
  type FileGitState,
  type GitStatus,
} from "@/features/git";
import {
  loadInspectionStats,
  type InspectionItemStats,
} from "../api/inspection";
import type { ChangesStats } from "../model/list-summary";
import type { InspectionScope } from "../model/scope";

const BATCH_SIZE = 50;

interface LoadedStats {
  /** The state of the path in the status the statistics were read for. */
  state: FileGitState | undefined;
  stats: InspectionItemStats;
  /** The batch failed: shown as unknown and read again with a new status. */
  failed: boolean;
}

/**
 * The statistics of `paths` in `scope`, loaded in batches in list order.
 * A new status object reads only the paths that are new or whose state
 * changed; the rest keep their statistics (DF-276 R3).
 */
export function useChangesStats(
  scope: InspectionScope,
  status: GitStatus | undefined,
  paths: string[],
): ChangesStats {
  const pathsKey = scope.kind === "file" ? "" : paths.join("\0");
  const requested = useMemo(
    () => (pathsKey ? pathsKey.split("\0") : []),
    [pathsKey],
  );
  const sequence = useRef(0);
  // One accumulating cache per scope, filled in place by the batches.
  const [cache] = useState(
    () => new WeakMap<InspectionScope, Map<string, LoadedStats>>(),
  );
  const [, setVersion] = useState(0);
  useEffect(() => {
    let entries = cache.get(scope);
    if (!entries) {
      entries = new Map();
      cache.set(scope, entries);
    }
    // A path that left the list is read again when it comes back.
    const listed = new Set(requested);
    for (const path of entries.keys()) {
      if (!listed.has(path)) entries.delete(path);
    }
    const stateOf = (path: string) => gitStatusFileAt(status, path)?.state;
    const missing = requested.filter((path) => {
      const entry = entries.get(path);
      return !entry || entry.failed || entry.state !== stateOf(path);
    });
    if (!missing.length) return;
    let active = true;
    const generation = String(++sequence.current);
    void (async () => {
      for (
        let start = 0;
        active && start < missing.length;
        start += BATCH_SIZE
      ) {
        const batch = missing.slice(start, start + BATCH_SIZE);
        let items: InspectionItemStats[];
        let failed = false;
        try {
          const response = await loadInspectionStats(
            scope.spacePath,
            batch,
            generation,
            scope,
          );
          if (response.generation !== generation)
            throw new Error("Stale statistics");
          const received = new Map(
            response.items.map((item) => [item.path, item]),
          );
          items = batch.map(
            (path) =>
              received.get(path) ?? {
                path,
                additions: null,
                deletions: null,
              },
          );
        } catch {
          failed = true;
          items = batch.map((path) => ({
            path,
            additions: null,
            deletions: null,
          }));
        }
        if (!active) return;
        for (const item of items) {
          entries.set(item.path, {
            state: stateOf(item.path),
            stats: item,
            failed,
          });
        }
        setVersion((version) => version + 1);
      }
    })();
    return () => {
      active = false;
    };
  }, [cache, scope, status, requested]);
  const entries = cache.get(scope);
  return {
    get: (path) => {
      const entry = entries?.get(path);
      if (!entry || entry.state !== gitStatusFileAt(status, path)?.state)
        return undefined;
      return entry.stats;
    },
  };
}
