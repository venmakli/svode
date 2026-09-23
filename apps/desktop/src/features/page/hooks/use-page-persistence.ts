import { useCallback, useEffect, useRef, useState } from "react";

import type {
  RepositoryAccessPreflightController,
  RepositoryAccessRequest,
} from "@/features/git";
import * as m from "@/paraglide/messages.js";

import {
  pageSourceErrorKind,
  type PageSourceConflict,
} from "../model/source-conflict";

export type PagePersistenceKind = "body" | "metadata";
export type PagePersistenceFlush = () => Promise<void>;
export type MakePageAccessRequest = (
  continuation: RepositoryAccessRequest["continuation"],
  intentKey: string,
  intentLabel: string,
  continueIntent: () => void | Promise<void>,
) => RepositoryAccessRequest;

export function usePagePersistence({
  makeAccessRequest,
  recovery,
  targetKey,
}: {
  makeAccessRequest: MakePageAccessRequest;
  recovery: RepositoryAccessPreflightController;
  targetKey: string;
}) {
  const persistenceRef = useRef(
    new Map<
      symbol,
      {
        kind: PagePersistenceKind;
        flush: PagePersistenceFlush;
        retry?: PagePersistenceFlush;
      }
    >(),
  );
  const writeBlockedRef = useRef(false);
  const sourceConflictRef = useRef<PageSourceConflict | null>(null);
  const recoverWriteErrorRef = useRef<
    (error: unknown, retry: () => Promise<void>) => Promise<boolean>
  >(async () => false);
  const retryPersistenceRef = useRef<(() => Promise<void>) | null>(null);
  const persistenceQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [sourceConflict, setSourceConflict] =
    useState<PageSourceConflict | null>(null);

  const reportSourceConflict = useCallback(
    (conflict: PageSourceConflict | null) => {
      sourceConflictRef.current = conflict;
      setSourceConflict(conflict);
    },
    [],
  );

  const registerPersistence = useCallback(
    (
      kind: PagePersistenceKind,
      flush: PagePersistenceFlush,
      retry?: PagePersistenceFlush,
    ) => {
      const key = Symbol(kind);
      persistenceRef.current.set(key, { kind, flush, retry });
      return () => persistenceRef.current.delete(key);
    },
    [],
  );

  const flushPersistenceNow = useCallback(async (): Promise<boolean> => {
    const participants = [...persistenceRef.current.values()].sort(
      (left, right) =>
        persistencePriority(left.kind) - persistencePriority(right.kind),
    );
    try {
      for (const participant of participants) await participant.flush();
      if (writeBlockedRef.current || sourceConflictRef.current) return false;
      setPersistenceError(null);
      retryPersistenceRef.current = null;
      return true;
    } catch (error) {
      const retry = async () => {
        for (const participant of participants)
          await (participant.retry ?? participant.flush)();
        writeBlockedRef.current = false;
        setPersistenceError(null);
        retryPersistenceRef.current = null;
      };
      if (await recoverWriteErrorRef.current(error, retry)) return false;
      retryPersistenceRef.current = retry;
      setPersistenceError(m.page_surface_save_error());
      return false;
    }
  }, []);

  const enqueuePersistenceTask = useCallback(
    <Result>(task: () => Promise<Result>) => {
      const result = persistenceQueueRef.current.then(task, task);
      persistenceQueueRef.current = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    [],
  );

  const flushPersistence = useCallback(
    () => enqueuePersistenceTask(flushPersistenceNow),
    [enqueuePersistenceTask, flushPersistenceNow],
  );

  const recoverWriteError = useCallback(
    async (error: unknown, retry: () => Promise<void>) => {
      const explicitRetry = async () => {
        await enqueuePersistenceTask(retry);
        writeBlockedRef.current = false;
        setPersistenceError(null);
        retryPersistenceRef.current = null;
      };
      if (pageSourceErrorKind(error) === "source_busy") {
        writeBlockedRef.current = true;
        retryPersistenceRef.current = explicitRetry;
        setPersistenceError(m.page_surface_save_busy());
        return true;
      }
      const request = makeAccessRequest(
        "explicit",
        `page-save:${targetKey}`,
        m.page_surface_save_intent(),
        async () => {
          try {
            await explicitRetry();
          } catch (retryError) {
            const handled = await recoverWriteErrorRef.current(
              retryError,
              retry,
            );
            if (!handled) {
              retryPersistenceRef.current = retry;
              setPersistenceError(m.page_surface_save_error());
            }
          }
        },
      );
      const handled = await recovery.recoverFromError(error, request);
      if (handled) {
        writeBlockedRef.current = true;
        retryPersistenceRef.current = explicitRetry;
      }
      return handled;
    },
    [enqueuePersistenceTask, makeAccessRequest, recovery, targetKey],
  );
  useEffect(() => {
    recoverWriteErrorRef.current = recoverWriteError;
  }, [recoverWriteError]);

  const dismissRecovery = useCallback(() => {
    recovery.close();
    if (writeBlockedRef.current && retryPersistenceRef.current) {
      setPersistenceError(m.page_surface_save_error());
    }
  }, [recovery]);

  const runMutation = useCallback(
    (operation: () => Promise<void>) =>
      enqueuePersistenceTask(async () => {
        if (!(await flushPersistenceNow())) return;
        try {
          await operation();
        } catch (error) {
          if (await recoverWriteErrorRef.current(error, operation)) return;
          throw error;
        }
      }),
    [enqueuePersistenceTask, flushPersistenceNow],
  );

  const retryPersistence = useCallback(async () => {
    const retry = retryPersistenceRef.current;
    if (!retry) return;
    try {
      await retry();
    } catch (error) {
      if (!(await recoverWriteError(error, retry))) {
        setPersistenceError(m.page_surface_save_error());
      }
    }
  }, [recoverWriteError]);

  return {
    dismissRecovery,
    flushPersistence,
    persistenceError,
    recoverWriteError,
    registerPersistence,
    reportSourceConflict,
    retryPersistence,
    runMutation,
    sourceConflict,
  };
}

function persistencePriority(kind: PagePersistenceKind) {
  return kind === "body" ? 100 : 200;
}
