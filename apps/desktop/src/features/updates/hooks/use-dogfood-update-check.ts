import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createDogfoodUpdateRuntime } from "../api/dogfood-update-runtime";

export function useDogfoodUpdateCheck(version: string, buildCommit: string) {
  const runtime = useMemo(
    () => createDogfoodUpdateRuntime(version, buildCommit),
    [version, buildCommit],
  );
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  useEffect(() => runtime.start(), [runtime]);
  return {
    ...snapshot,
    checking: snapshot.status === "checking",
    canCheck: runtime.canCheck,
    check: runtime.check,
    openUpdate: runtime.openUpdate,
  };
}
