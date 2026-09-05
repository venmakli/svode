import { useEffect, useMemo, useRef, useState } from "react";
import type { GitStatus } from "@/features/git";
import {
  loadInspectionStats,
  type InspectionItemStats,
} from "../api/inspection";
import type { InspectionScope } from "../model/scope";

const BATCH_SIZE = 50;

export function useChangesStats(
  scope: InspectionScope,
  status: GitStatus | undefined,
  paths: string[],
) {
  const pathsKey = scope.kind === "file" ? "" : paths.join("\0");
  const requested = useMemo(
    () => (pathsKey ? pathsKey.split("\0") : []),
    [pathsKey],
  );
  const sequence = useRef(0);
  const [result, setResult] = useState<{
    scope: InspectionScope;
    status: GitStatus | undefined;
    values: Record<string, InspectionItemStats>;
  }>();
  useEffect(() => {
    if (!requested.length) return;
    let active = true;
    const generation = String(++sequence.current);
    void (async () => {
      for (
        let start = 0;
        active && start < requested.length;
        start += BATCH_SIZE
      ) {
        const paths = requested.slice(start, start + BATCH_SIZE);
        let items: InspectionItemStats[];
        try {
          const response = await loadInspectionStats(
            scope.spacePath,
            paths,
            generation,
            scope,
          );
          if (response.generation !== generation)
            throw new Error("Stale statistics");
          const received = new Map(
            response.items.map((item) => [item.path, item]),
          );
          items = paths.map(
            (path) =>
              received.get(path) ?? {
                path,
                additions: null,
                deletions: null,
              },
          );
        } catch {
          items = paths.map((path) => ({
            path,
            additions: null,
            deletions: null,
          }));
        }
        if (!active) return;
        setResult((previous) => ({
          scope,
          status,
          values: {
            ...(previous?.scope === scope && previous.status === status
              ? previous.values
              : {}),
            ...Object.fromEntries(items.map((item) => [item.path, item])),
          },
        }));
      }
    })();
    return () => {
      active = false;
    };
  }, [scope, status, requested]);
  return result?.scope === scope && result.status === status
    ? result.values
    : {};
}
