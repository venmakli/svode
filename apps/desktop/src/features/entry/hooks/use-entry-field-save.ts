import { useCallback, useEffect, useRef } from "react";
import { updateEntryField } from "../api/entry-api";
import {
  enqueueEntryFieldSave,
  recordEntryFieldSavePathAlias,
  resolveEntryFieldSavePath,
} from "../lib/entry-field-save-queue";
import { publishEntryFilenameWarnings } from "../lib/filename-warning";
import type { Entry } from "../model/types";
import {
  entryFieldSavePolicy,
  mergeSavedEntryFieldResult,
  patchEntryField,
  rollbackEntryField,
  type EntryFieldSavePolicy,
} from "../model/field-save";

interface PendingFieldSave {
  timer: ReturnType<typeof setTimeout>;
  resolve: (entry: Entry | null) => void;
  reject: (error: unknown) => void;
  version: number;
  flush: () => Promise<Entry | null>;
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
  onTitleSaved,
  onSaved,
  onError,
}: {
  spacePath: string;
  projectPath?: string | null;
  applyEntryUpdate: (
    entryPath: string,
    update: (entry: Entry) => Entry,
  ) => void;
  onTitleSaved?: (previousPath: string, entry: Entry) => void;
  onSaved?: (entry: Entry, context: EntryFieldSaveContext) => void;
  onError?: (error: unknown, context: EntryFieldSaveContext) => void;
}) {
  const pendingRef = useRef(new Map<string, PendingFieldSave>());
  const versionsRef = useRef(new Map<string, number>());
  const pathAliasesRef = useRef(new Map<string, string>());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const pending = pendingRef.current;
    const pathAliases = pathAliasesRef.current;
    return () => {
      mountedRef.current = false;
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        void item.flush().then(item.resolve).catch(item.reject);
      }
      pending.clear();
      pathAliases.clear();
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

      const optimisticPath = resolveEntryFieldSavePath(
        pathAliasesRef.current,
        entry.path,
      );
      const applyOptimisticUpdate = (current: Entry) =>
        patchEntryField(current, field, value);
      applyEntryUpdate(entry.path, applyOptimisticUpdate);
      if (optimisticPath !== entry.path) {
        applyEntryUpdate(optimisticPath, applyOptimisticUpdate);
      }

      const previous = pendingRef.current.get(key);
      if (previous) {
        clearTimeout(previous.timer);
        previous.resolve(null);
        pendingRef.current.delete(key);
      }

      const flushPendingEntryFields = async () => {
        const prefix = `${entry.path}:`;
        const pending = Array.from(pendingRef.current.entries()).filter(
          ([pendingKey]) => pendingKey.startsWith(prefix),
        );
        for (const [pendingKey, item] of pending) {
          clearTimeout(item.timer);
          pendingRef.current.delete(pendingKey);
        }
        await Promise.all(
          pending.map(async ([, item]) => {
            try {
              const result = await item.flush();
              item.resolve(result);
            } catch (error) {
              item.reject(error);
              throw error;
            }
          }),
        );
      };

      const runSave = async ({
        applyResult = true,
        rollbackOnError = true,
      }: {
        applyResult?: boolean;
        rollbackOnError?: boolean;
      } = {}) => {
        let requestPath = entry.path;
        try {
          if (field === "title" && options.flush) {
            await flushPendingEntryFields();
          }
          const queuePath = resolveEntryFieldSavePath(
            pathAliasesRef.current,
            entry.path,
          );
          const updated = await enqueueEntryFieldSave(
            `${spacePath}:${queuePath}`,
            () => {
              requestPath = resolveEntryFieldSavePath(
                pathAliasesRef.current,
                entry.path,
              );
              return updateEntryField({
                spacePath,
                filePath: requestPath,
                field,
                value,
                projectPath: projectPath ?? null,
              });
            },
          );
          if (versionsRef.current.get(key) !== version) return null;
          if (field === "title") {
            if (updated.path !== requestPath) {
              recordEntryFieldSavePathAlias(
                pathAliasesRef.current,
                requestPath,
                updated.path,
              );
            }
            publishEntryFilenameWarnings(updated.warnings);
            onTitleSaved?.(requestPath, updated);
          }
          const outcomeContext =
            requestPath === context.previousEntry.path
              ? context
              : {
                  ...context,
                  previousEntry: { ...context.previousEntry, path: requestPath },
                };
          let appliedEntry: Entry | null = null;
          if (applyResult && mountedRef.current) {
            const applySavedUpdate = (current: Entry) => {
              return (appliedEntry = mergeSavedEntryFieldResult(
                current,
                field,
                updated,
                Boolean(onTitleSaved),
              ));
            };
            applyEntryUpdate(requestPath, applySavedUpdate);
            if (requestPath !== entry.path) {
              applyEntryUpdate(entry.path, applySavedUpdate);
            }
          }
          const result = appliedEntry ?? updated;
          onSaved?.(updated, outcomeContext);
          return result;
        } catch (error) {
          if (versionsRef.current.get(key) === version) {
            const rollbackPath = resolveEntryFieldSavePath(
              pathAliasesRef.current,
              requestPath,
            );
            if (rollbackOnError && mountedRef.current) {
              const applyRollback = (current: Entry) =>
                rollbackEntryField(current, field, entry);
              applyEntryUpdate(rollbackPath, applyRollback);
              if (rollbackPath !== entry.path) {
                applyEntryUpdate(entry.path, applyRollback);
              }
            }
            onError?.(
              error,
              rollbackPath === context.previousEntry.path
                ? context
                : {
                    ...context,
                    previousEntry: {
                      ...context.previousEntry,
                      path: rollbackPath,
                    },
                  },
            );
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
        pendingRef.current.set(key, {
          timer,
          resolve,
          reject,
          version,
          flush: () => runSave(),
        });
      });
    },
    [applyEntryUpdate, onError, onSaved, onTitleSaved, projectPath, spacePath],
  );
}
