import { useCallback, useEffect, useMemo, useRef } from "react";
import { updateEntryField } from "../api/entry-api";
import {
  enqueueEntryFieldSave,
  recordEntryFieldSavePathAlias,
  resolveEntryFieldSavePath,
} from "../lib/entry-field-save-queue";
import { publishEntryFilenameWarnings } from "../lib/filename-warning";
import type { Entry } from "../model/types";
import { publishEntryTitleOutcome } from "./entry-selection-actions";
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

export interface EntryFieldSaveController {
  save: (
    entry: Entry,
    field: string,
    value: unknown,
    options?: SaveEntryFieldOptions,
  ) => Promise<Entry | null>;
  flush: () => Promise<void>;
}

export function useEntryFieldSave({
  spacePath,
  projectPath,
  applyEntryUpdate,
  deferTitlePathAdoption = false,
  onSaved,
  onError,
  recoverFromError,
}: {
  spacePath: string;
  projectPath?: string | null;
  applyEntryUpdate: (
    entryPath: string,
    update: (entry: Entry) => Entry,
  ) => void;
  deferTitlePathAdoption?: boolean;
  onSaved?: (entry: Entry, context: EntryFieldSaveContext) => void;
  onError?: (error: unknown, context: EntryFieldSaveContext) => void;
  recoverFromError?: (
    error: unknown,
    context: EntryFieldSaveContext,
    retry: () => Promise<void>,
  ) => Promise<boolean>;
}): EntryFieldSaveController {
  const pendingRef = useRef(new Map<string, PendingFieldSave>());
  const inFlightRef = useRef(new Set<Promise<Entry | null>>());
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

  const trackInFlight = useCallback((promise: Promise<Entry | null>) => {
    inFlightRef.current.add(promise);
    void promise
      .finally(() => inFlightRef.current.delete(promise))
      .catch(() => undefined);
    return promise;
  }, []);

  const flush = useCallback(async () => {
    const pending = [...pendingRef.current.entries()];
    for (const [key, item] of pending) {
      clearTimeout(item.timer);
      pendingRef.current.delete(key);
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
    await Promise.all([...inFlightRef.current]);
  }, []);

  const saveField = useCallback(
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
        allowRecovery = true,
        notifyOnError = true,
        rollbackOnError = true,
      }: {
        applyResult?: boolean;
        allowRecovery?: boolean;
        notifyOnError?: boolean;
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
            publishEntryTitleOutcome(spacePath, requestPath, updated);
          }
          const outcomeContext =
            requestPath === context.previousEntry.path
              ? context
              : {
                  ...context,
                  previousEntry: {
                    ...context.previousEntry,
                    path: requestPath,
                  },
                };
          let appliedEntry: Entry | null = null;
          if (applyResult && mountedRef.current) {
            const applySavedUpdate = (current: Entry) => {
              return (appliedEntry = mergeSavedEntryFieldResult(
                current,
                field,
                updated,
                deferTitlePathAdoption,
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
            const errorContext =
              rollbackPath === context.previousEntry.path
                ? context
                : {
                    ...context,
                    previousEntry: {
                      ...context.previousEntry,
                      path: rollbackPath,
                    },
                  };
            if (
              allowRecovery &&
              recoverFromError &&
              (await recoverFromError(error, errorContext, async () => {
                await trackInFlight(
                  runSave({
                    rollbackOnError: false,
                    allowRecovery: false,
                    notifyOnError: false,
                  }),
                );
              }))
            ) {
              return null;
            }
            if (rollbackOnError && mountedRef.current) {
              const applyRollback = (current: Entry) =>
                rollbackEntryField(current, field, entry);
              applyEntryUpdate(rollbackPath, applyRollback);
              if (rollbackPath !== entry.path) {
                applyEntryUpdate(entry.path, applyRollback);
              }
            }
            if (notifyOnError) onError?.(error, errorContext);
          }
          throw error;
        }
      };

      if (policy.mode === "immediate" || options.flush) {
        return trackInFlight(runSave());
      }

      return new Promise<Entry | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pendingRef.current.get(key)?.version === version) {
            pendingRef.current.delete(key);
          }
          void trackInFlight(runSave()).then(resolve).catch(reject);
        }, policy.delayMs ?? 0);
        pendingRef.current.set(key, {
          timer,
          resolve,
          reject,
          version,
          flush: () => trackInFlight(runSave()),
        });
      });
    },
    [
      applyEntryUpdate,
      deferTitlePathAdoption,
      onError,
      onSaved,
      projectPath,
      recoverFromError,
      spacePath,
      trackInFlight,
    ],
  );

  return useMemo(() => ({ flush, save: saveField }), [flush, saveField]);
}
