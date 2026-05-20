import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Entry } from "@/features/editor/types";

interface PendingUpdate {
  timer: ReturnType<typeof setTimeout>;
  resolve: (entry: Entry | null) => void;
}

export function useDebouncedEntryFieldUpdate({
  spacePath,
  projectPath,
  setEntry,
  onSaved,
  delay = 500,
}: {
  spacePath: string;
  projectPath?: string | null;
  setEntry: Dispatch<SetStateAction<Entry | null>>;
  onSaved?: (entry: Entry) => void;
  delay?: number;
}) {
  const pendingRef = useRef(new Map<string, PendingUpdate>());

  useEffect(() => {
    return () => {
      for (const pending of pendingRef.current.values()) {
        clearTimeout(pending.timer);
        pending.resolve(null);
      }
      pendingRef.current.clear();
    };
  }, []);

  return useCallback(
    (entry: Entry, field: string, value: unknown) => {
      setEntry((current) =>
        current && current.path === entry.path
          ? patchEntryField(current, field, value)
          : current,
      );

      const key = `${entry.path}:${field}`;
      const previous = pendingRef.current.get(key);
      if (previous) {
        clearTimeout(previous.timer);
        previous.resolve(null);
      }

      return new Promise<Entry | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRef.current.delete(key);
          void invoke<Entry>("update_entry_field", {
            space: spacePath,
            filePath: entry.path,
            field,
            value,
            projectPath: projectPath ?? null,
          })
            .then((updated) => {
              setEntry(updated);
              onSaved?.(updated);
              resolve(updated);
            })
            .catch(reject);
        }, delay);
        pendingRef.current.set(key, { timer, resolve });
      });
    },
    [delay, onSaved, projectPath, setEntry, spacePath],
  );
}

function patchEntryField(entry: Entry, field: string, value: unknown): Entry {
  if (field === "title" && typeof value === "string") {
    return { ...entry, meta: { ...entry.meta, title: value } };
  }
  if (field === "icon") {
    return {
      ...entry,
      meta: { ...entry.meta, icon: typeof value === "string" ? value : null },
    };
  }
  if (field === "description") {
    return {
      ...entry,
      meta: {
        ...entry.meta,
        description: typeof value === "string" && value.trim() ? value : null,
      },
    };
  }
  if (field === "cover") {
    return { ...entry, meta: { ...entry.meta, cover: value as never } };
  }

  const extra = { ...entry.meta.extra };
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  ) {
    delete extra[field];
  } else {
    extra[field] = value;
  }
  return { ...entry, meta: { ...entry.meta, extra } };
}
