import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import { invokeCommand as invoke } from "@/platform/native/invoke";
import type { Entry } from "@/features/entry";

interface PendingUpdate {
  timer: ReturnType<typeof setTimeout>;
  resolve: (entry: Entry | null) => void;
  version: number;
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
  const versionsRef = useRef(new Map<string, number>());

  useEffect(() => {
    const pending = pendingRef.current;
    return () => {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.resolve(null);
      }
      pending.clear();
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
      const version = (versionsRef.current.get(key) ?? 0) + 1;
      versionsRef.current.set(key, version);
      const previous = pendingRef.current.get(key);
      if (previous) {
        clearTimeout(previous.timer);
        previous.resolve(null);
      }

      return new Promise<Entry | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pendingRef.current.get(key)?.version === version) {
            pendingRef.current.delete(key);
          }
          void invoke<Entry>("update_entry_field", {
            space: spacePath,
            filePath: entry.path,
            field,
            value,
            projectPath: projectPath ?? null,
          })
            .then((updated) => {
              if (versionsRef.current.get(key) !== version) {
                resolve(null);
                return;
              }
              setEntry(updated);
              onSaved?.(updated);
              resolve(updated);
            })
            .catch(reject);
        }, delay);
        pendingRef.current.set(key, { timer, resolve, version });
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
