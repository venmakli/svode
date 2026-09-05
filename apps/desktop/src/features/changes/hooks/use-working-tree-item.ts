import { useEffect, useState } from "react";
import type { GitStatus } from "@/features/git";
import { revealChangedSource, type WorkingTreeItem } from "../api/inspection";
import type { ItemReader } from "../model/item-reader";
import type { InspectionScope } from "../model/scope";

export function useWorkingTreeItem(
  reader: ItemReader,
  scope: InspectionScope,
  path: string,
  status: GitStatus | undefined,
  enabled: boolean,
) {
  const [retry, setRetry] = useState(0);
  const [sourceError, setSourceError] = useState(false);
  const [result, setResult] = useState<{
    item?: WorkingTreeItem;
    error?: boolean;
    status?: GitStatus;
    key?: string;
    retry?: number;
  }>({});
  const key = `${scope.spacePath}\0${scope.kind}\0${scope.path}\0${path}`;
  useEffect(() => {
    if (!enabled) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled)
          setResult((current) =>
            current.item || current.error ? {} : current,
          );
      });
      return () => {
        cancelled = true;
      };
    }
    let active = true;
    void reader
      .read(scope, path, () => active)
      .then(
        (item) => {
          if (active && item) setResult({ item, status, key, retry });
        },
        () => {
          if (active) setResult({ error: true, status, key, retry });
        },
      );
    return () => {
      active = false;
      reader.release(path);
    };
  }, [reader, scope, key, path, status, enabled, retry]);
  const matches = result.key === key;
  const updating =
    enabled && (!matches || result.status !== status || result.retry !== retry);
  return {
    item: matches ? result.item : undefined,
    error: matches && !updating && result.error,
    updating,
    sourceError,
    retry: () => setRetry((value) => value + 1),
    reveal: async () => {
      setSourceError(false);
      try {
        await revealChangedSource(scope, path);
      } catch {
        setSourceError(true);
      }
    },
  };
}
