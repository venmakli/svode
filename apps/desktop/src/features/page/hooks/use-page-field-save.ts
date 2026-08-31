import { useCallback, useEffect, useMemo, useRef } from "react";
import { updatePageField } from "../api/page-api";
import {
  enqueuePageFieldSave,
  recordPageFieldSavePathAlias,
  resolvePageFieldSavePath,
} from "../lib/page-field-save-queue";
import { publishPageFilenameWarnings } from "../lib/filename-warning";
import type { Page } from "../model/types";
import { publishPageTitleOutcome } from "./page-navigation-actions";
import {
  pageFieldSavePolicy,
  mergeSavedPageFieldResult,
  patchPageField,
  rollbackPageField,
  type PageFieldSavePolicy,
} from "../model/field-save";

interface PendingFieldSave {
  timer: ReturnType<typeof setTimeout>;
  resolve: (page: Page | null) => void;
  reject: (error: unknown) => void;
  version: number;
  flush: () => Promise<Page | null>;
}

export interface PageFieldSaveContext {
  field: string;
  value: unknown;
  previousPage: Page;
  policy: PageFieldSavePolicy;
}

export interface SavePageFieldOptions {
  policy?: PageFieldSavePolicy;
  flush?: boolean;
}

export interface PageFieldSaveController {
  save: (
    page: Page,
    field: string,
    value: unknown,
    options?: SavePageFieldOptions,
  ) => Promise<Page | null>;
  flush: () => Promise<void>;
}

export function usePageFieldSave({
  spacePath,
  projectPath,
  applyPageUpdate,
  deferTitlePathAdoption = false,
  onSaved,
  onError,
  recoverFromError,
}: {
  spacePath: string;
  projectPath?: string | null;
  applyPageUpdate: (
    pagePath: string,
    update: (page: Page) => Page,
  ) => void;
  deferTitlePathAdoption?: boolean;
  onSaved?: (page: Page, context: PageFieldSaveContext) => void;
  onError?: (error: unknown, context: PageFieldSaveContext) => void;
  recoverFromError?: (
    error: unknown,
    context: PageFieldSaveContext,
    retry: () => Promise<void>,
  ) => Promise<boolean>;
}): PageFieldSaveController {
  const pendingRef = useRef(new Map<string, PendingFieldSave>());
  const inFlightRef = useRef(new Set<Promise<Page | null>>());
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

  const trackInFlight = useCallback((promise: Promise<Page | null>) => {
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
      page: Page,
      field: string,
      value: unknown,
      options: SavePageFieldOptions = {},
    ) => {
      const policy = options.policy ?? pageFieldSavePolicy(field);
      const context: PageFieldSaveContext = {
        field,
        value,
        previousPage: page,
        policy,
      };
      const key = `${page.path}:${field}`;
      const version = (versionsRef.current.get(key) ?? 0) + 1;
      versionsRef.current.set(key, version);

      const optimisticPath = resolvePageFieldSavePath(
        pathAliasesRef.current,
        page.path,
      );
      const applyOptimisticUpdate = (current: Page) =>
        patchPageField(current, field, value);
      applyPageUpdate(page.path, applyOptimisticUpdate);
      if (optimisticPath !== page.path) {
        applyPageUpdate(optimisticPath, applyOptimisticUpdate);
      }

      const previous = pendingRef.current.get(key);
      if (previous) {
        clearTimeout(previous.timer);
        previous.resolve(null);
        pendingRef.current.delete(key);
      }

      const flushPendingPageFields = async () => {
        const prefix = `${page.path}:`;
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
        let requestPath = page.path;
        try {
          if (field === "title" && options.flush) {
            await flushPendingPageFields();
          }
          const queuePath = resolvePageFieldSavePath(
            pathAliasesRef.current,
            page.path,
          );
          const updated = await enqueuePageFieldSave(
            `${spacePath}:${queuePath}`,
            () => {
              requestPath = resolvePageFieldSavePath(
                pathAliasesRef.current,
                page.path,
              );
              return updatePageField({
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
              recordPageFieldSavePathAlias(
                pathAliasesRef.current,
                requestPath,
                updated.path,
              );
            }
            publishPageFilenameWarnings(updated.warnings);
            publishPageTitleOutcome(spacePath, requestPath, updated);
          }
          const outcomeContext =
            requestPath === context.previousPage.path
              ? context
              : {
                  ...context,
                  previousPage: {
                    ...context.previousPage,
                    path: requestPath,
                  },
                };
          let appliedPage: Page | null = null;
          if (applyResult && mountedRef.current) {
            const applySavedUpdate = (current: Page) => {
              return (appliedPage = mergeSavedPageFieldResult(
                current,
                field,
                updated,
                deferTitlePathAdoption,
              ));
            };
            applyPageUpdate(requestPath, applySavedUpdate);
            if (requestPath !== page.path) {
              applyPageUpdate(page.path, applySavedUpdate);
            }
          }
          const result = appliedPage ?? updated;
          onSaved?.(updated, outcomeContext);
          return result;
        } catch (error) {
          if (versionsRef.current.get(key) === version) {
            const rollbackPath = resolvePageFieldSavePath(
              pathAliasesRef.current,
              requestPath,
            );
            const errorContext =
              rollbackPath === context.previousPage.path
                ? context
                : {
                    ...context,
                    previousPage: {
                      ...context.previousPage,
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
              const applyRollback = (current: Page) =>
                rollbackPageField(current, field, page);
              applyPageUpdate(rollbackPath, applyRollback);
              if (rollbackPath !== page.path) {
                applyPageUpdate(page.path, applyRollback);
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

      return new Promise<Page | null>((resolve, reject) => {
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
      applyPageUpdate,
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
