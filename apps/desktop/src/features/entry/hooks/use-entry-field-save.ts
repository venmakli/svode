import { useCallback, useEffect, useRef } from "react";
import { updateEntryField } from "@/platform/entries/entries-api";
import type { Entry } from "../model/types";
import {
  entryFieldSavePolicy,
  mergeSavedEntryField,
  patchEntryField,
  type EntryFieldSavePolicy,
} from "../model/field-save";

interface PendingFieldSave {
  timer: ReturnType<typeof setTimeout>;
  resolve: (entry: Entry | null) => void;
  version: number;
}

export interface EntryFieldSaveContext {
  field: string;
  value: unknown;
  previousEntry: Entry;
  policy: EntryFieldSavePolicy;
}

export interface SaveEntryFieldOptions {
  policy?: EntryFieldSavePolicy;
  flush?: boolean;
}

export function useEntryFieldSave({
  spacePath,
  projectPath,
  applyEntryUpdate,
  onSaved,
  onError,
}: {
  spacePath: string;
  projectPath?: string | null;
  applyEntryUpdate: (
    entryPath: string,
    update: (entry: Entry) => Entry,
  ) => void;
  onSaved?: (entry: Entry, context: EntryFieldSaveContext) => void;
  onError?: (error: unknown, context: EntryFieldSaveContext) => void;
}) {
  const pendingRef = useRef(new Map<string, PendingFieldSave>());
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
    (
      entry: Entry,
      field: string,
      value: unknown,
      options: SaveEntryFieldOptions = {},
    ) => {
      const policy = options.policy ?? entryFieldSavePolicy(field);
      const context: EntryFieldSaveContext = {
        field,
        value,
        previousEntry: entry,
        policy,
      };
      const key = `${entry.path}:${field}`;
      const version = (versionsRef.current.get(key) ?? 0) + 1;
      versionsRef.current.set(key, version);

      applyEntryUpdate(entry.path, (current) =>
        patchEntryField(current, field, value),
      );

      const previous = pendingRef.current.get(key);
      if (previous) {
        clearTimeout(previous.timer);
        previous.resolve(null);
        pendingRef.current.delete(key);
      }

      const runSave = async () => {
        try {
          const updated = (await updateEntryField({
            space: spacePath,
            filePath: entry.path,
            field,
            value,
            projectPath: projectPath ?? null,
          })) as Entry;
          if (versionsRef.current.get(key) !== version) return null;
          let appliedEntry: Entry | null = null;
          applyEntryUpdate(entry.path, (current) =>
            (appliedEntry = mergeSavedEntryField(current, field, updated)),
          );
          const result = appliedEntry ?? updated;
          onSaved?.(result, context);
          return result;
        } catch (error) {
          if (versionsRef.current.get(key) === version) {
            applyEntryUpdate(entry.path, (current) =>
              mergeSavedEntryField(current, field, entry),
            );
            onError?.(error, context);
          }
          throw error;
        }
      };

      if (policy.mode === "immediate" || options.flush) {
        return runSave();
      }

      return new Promise<Entry | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pendingRef.current.get(key)?.version === version) {
            pendingRef.current.delete(key);
          }
          void runSave().then(resolve).catch(reject);
        }, policy.delayMs ?? 0);
        pendingRef.current.set(key, { timer, resolve, version });
      });
    },
    [applyEntryUpdate, onError, onSaved, projectPath, spacePath],
  );
}
