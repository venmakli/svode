import { useCallback, useState } from "react";
import type { ColumnSizingState } from "@tanstack/react-table";

export function usePersistentSet(key: string) {
  const [values, setValues] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) ?? "[]"));
    } catch {
      return new Set();
    }
  });

  const toggle = useCallback(
    (value: string) => {
      setValues((current) => {
        const next = new Set(current);
        if (next.has(value)) next.delete(value);
        else next.add(value);
        localStorage.setItem(key, JSON.stringify([...next]));
        return next;
      });
    },
    [key],
  );

  return [values, toggle] as const;
}

export function usePersistentSizing(key: string) {
  const [sizing, setSizing] = useState<ColumnSizingState>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "{}");
    } catch {
      return {};
    }
  });

  const setAndPersist = useCallback(
    (
      updater:
        | ColumnSizingState
        | ((old: ColumnSizingState) => ColumnSizingState),
    ) => {
      setSizing((current) => {
        const next = typeof updater === "function" ? updater(current) : updater;
        localStorage.setItem(key, JSON.stringify(next));
        return next;
      });
    },
    [key],
  );

  return [sizing, setAndPersist] as const;
}
