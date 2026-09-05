import { useEffect, useSyncExternalStore } from "react";
import type { ChangesTarget } from "../model/scope";

let current: ChangesTarget | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useMainChangesTarget() {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}

export function usePublishMainChangesTarget(target: ChangesTarget | null) {
  const projectPath = target?.projectPath;
  const sessionKey = target?.sessionKey;
  const kind = target?.kind;
  const sourceShape = target?.sourceShape;
  const spacePath = target?.spacePath;
  const path = target?.path;
  const name = target?.name;
  useEffect(() => {
    if (!kind || !sourceShape || !spacePath || path === undefined || !name)
      return;
    const published = {
      kind,
      sourceShape,
      spacePath,
      projectPath,
      sessionKey,
      path,
      name,
    };
    current = published;
    listeners.forEach((listener) => listener());
    return () => {
      if (current !== published) return;
      current = null;
      listeners.forEach((listener) => listener());
    };
  }, [kind, sourceShape, spacePath, projectPath, sessionKey, path, name]);
}
