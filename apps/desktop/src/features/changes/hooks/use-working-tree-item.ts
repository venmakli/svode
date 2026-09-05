import { useEffect, useRef, useState } from "react";
import type { GitStatus } from "@/features/git";
import { loadWorkingTreeItem, type WorkingTreeItem } from "../api/inspection";

export function useWorkingTreeItem(
  spacePath: string,
  path: string,
  status: GitStatus | undefined,
  enabled: boolean,
) {
  const generation = useRef(0);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{
    item?: WorkingTreeItem;
    error?: boolean;
    status?: GitStatus;
  }>({});
  useEffect(() => {
    if (!enabled) return;
    const version = String(++generation.current);
    let active = true;
    void loadWorkingTreeItem(spacePath, path, version).then(
      (item) => {
        if (active && item.path === path && item.generation === version)
          setResult({ item, status });
      },
      () => {
        if (active) setResult({ error: true, status });
      },
    );
    return () => {
      active = false;
    };
  }, [spacePath, path, status, enabled, retry]);
  const matches = result.status === status && result.item?.path === path;
  return {
    item: matches ? result.item : undefined,
    error: result.status === status && result.error,
    retry: () => {
      setResult({});
      setRetry((value) => value + 1);
    },
  };
}
