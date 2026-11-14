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
import type { PageGoneState } from "../model/source-gone";
import type { WritePageResult } from "../model/types";

export type PagePersistenceKind = "body" | "metadata";
export type PagePersistenceFlush = () => Promise<void>;
/**
 * Writes the Page file again at the path it disappeared from, with `body`
 * as its text, or the last read body when null; throws when refused.
 */
export type PageSourceRestoreWrite = (
  body: string | null,
) => Promise<WritePageResult>;
export interface PagePersistenceParticipant {
  flush: PagePersistenceFlush;
  /** Repeats a failed save; defaults to `flush`. */
  retry?: PagePersistenceFlush;
  /** Drops unsaved drafts and shows the last saved source again, writing nothing. */
  discard: PagePersistenceFlush;
  /** Whether it holds unsaved work: a draft, or a pending, in-flight or blocked write. */
  hasWork?: () => boolean;
  /** Drops unsaved drafts without reading the source, whose file is gone. */
  drop?: () => void | Promise<void>;
  /** The body text with its unsaved edits, as a write would send it. */
  text?: () => string;
  /**
   * Writes the gone Page file again through `write` with its body text and
   * adopts the written source as saved.
   */
  restore?: (write: PageSourceRestoreWrite) => Promise<void>;
}

/**
 * The owner of a Page session whose file disappeared outside this window
 * while it held unsaved work (DF-269 R3).
 */
export interface PageGoneSource {
  /** Writes the file again and adopts the written metadata as saved. */
  restore: PageSourceRestoreWrite;
  /** Closes the surface once its unsaved work is dropped. */
  close: () => void;
  /** The body text when no editor holds it. */
  text: () => string;
  /** The user-facing cause of a refused restore, when the owner names it. */
  refusal: (error: unknown) => string | null;
}

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
      PagePersistenceParticipant & { kind: PagePersistenceKind }
    >(),
  );
  const writeBlockedRef = useRef(false);
  const sourceConflictRef = useRef<PageSourceConflict | null>(null);
  const recoverWriteErrorRef = useRef<
    (error: unknown, retry: () => Promise<void>) => Promise<boolean>
  >(async () => false);
  const retryPersistenceRef = useRef<(() => Promise<void>) | null>(null);
  const restoreGoneSourceRef = useRef<() => Promise<void>>(async () => {});
  const persistenceQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [sourceConflict, setSourceConflict] =
    useState<PageSourceConflict | null>(null);
  const goneSourceRef = useRef<PageGoneSource | null>(null);
  const [goneState, setGoneState] = useState<PageGoneState | null>(null);

  const reportSourceConflict = useCallback(
    (conflict: PageSourceConflict | null) => {
      sourceConflictRef.current = conflict;
      setSourceConflict(conflict);
    },
    [],
  );

  const registerPersistence = useCallback(
    (kind: PagePersistenceKind, participant: PagePersistenceParticipant) => {
      const key = Symbol(kind);
      persistenceRef.current.set(key, { kind, ...participant });
      return () => persistenceRef.current.delete(key);
    },
    [],
  );

  const orderedParticipants = useCallback(
    () =>
      [...persistenceRef.current.values()].sort(
        (left, right) =>
          persistencePriority(left.kind) - persistencePriority(right.kind),
      ),
    [],
  );

  const flushPersistenceNow = useCallback(async (): Promise<boolean> => {
    // Nothing is written at the path of a gone file; its work stays held.
    if (goneSourceRef.current) return false;
    const participants = orderedParticipants();
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
  }, [orderedParticipants]);

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

  const explicitRetryOf = useCallback(
    (retry: () => Promise<void>) => async () => {
      await enqueuePersistenceTask(retry);
      writeBlockedRef.current = false;
      setPersistenceError(null);
      retryPersistenceRef.current = null;
    },
    [enqueuePersistenceTask],
  );

  const recoverWriteError = useCallback(
    async (error: unknown, retry: () => Promise<void>) => {
      const explicitRetry = explicitRetryOf(retry);
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
    [explicitRetryOf, makeAccessRequest, recovery, targetKey],
  );
  useEffect(() => {
    recoverWriteErrorRef.current = recoverWriteError;
  }, [recoverWriteError]);

  // A failed write of the Page source blocks saving like refused access: the
  // draft stays, its writer pauses and the indicator names the failure.
  const recoverSourceWriteError = useCallback(
    async (error: unknown, retry: () => Promise<void>) => {
      if (await recoverWriteError(error, retry)) return true;
      console.error("Failed to save Page:", error);
      writeBlockedRef.current = true;
      retryPersistenceRef.current = explicitRetryOf(retry);
      setPersistenceError(m.page_surface_save_error());
      return true;
    },
    [explicitRetryOf, recoverWriteError],
  );

  const dropWork = useCallback(async () => {
    for (const participant of orderedParticipants())
      await (participant.drop ?? participant.discard)();
    goneSourceRef.current = null;
    setGoneState(null);
  }, [orderedParticipants]);

  // A gone file is not read to discard its work: the work is dropped.
  const discardChanges = useCallback(
    () =>
      enqueuePersistenceTask(async () => {
        if (goneSourceRef.current) await dropWork();
        else
          for (const participant of orderedParticipants())
            await participant.discard();
        writeBlockedRef.current = false;
        retryPersistenceRef.current = null;
        setPersistenceError(null);
        recovery.close();
      }),
    [dropWork, enqueuePersistenceTask, orderedParticipants, recovery],
  );

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

  const settled = useCallback(() => persistenceQueueRef.current, []);

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

  const holdsUnsavedWork = useCallback(
    () =>
      writeBlockedRef.current ||
      sourceConflictRef.current !== null ||
      [...persistenceRef.current.values()].some(
        (participant) => participant.hasWork?.() ?? false,
      ),
    [],
  );

  const writesHeld = useCallback(() => goneSourceRef.current !== null, []);

  const holdGoneSource = useCallback((owner: PageGoneSource) => {
    goneSourceRef.current = owner;
    setGoneState({ pending: false, error: null });
  }, []);

  const clearWriteBlock = useCallback(() => {
    writeBlockedRef.current = false;
    retryPersistenceRef.current = null;
    setPersistenceError(null);
  }, []);

  // The file is back: its work is compared with it and saved as any other
  // pending work, by the rules for a source another writer changed.
  const releaseGoneSource = useCallback(async () => {
    if (!goneSourceRef.current) return;
    goneSourceRef.current = null;
    setGoneState(null);
    // A write refused while the file was gone is repeated first, then every
    // participant saves again what it holds, a held draft included.
    if (retryPersistenceRef.current) await retryPersistence();
    const participants = orderedParticipants();
    const retry = async () => {
      for (const participant of participants)
        await (participant.retry ?? participant.flush)();
    };
    try {
      await enqueuePersistenceTask(retry);
      if (!writeBlockedRef.current) {
        retryPersistenceRef.current = null;
        setPersistenceError(null);
      }
    } catch (error) {
      if (await recoverWriteErrorRef.current(error, retry)) return;
      retryPersistenceRef.current = retry;
      setPersistenceError(m.page_surface_save_error());
    }
  }, [enqueuePersistenceTask, orderedParticipants, retryPersistence]);

  const restoreGoneSource = useCallback(async (): Promise<void> => {
    const owner = goneSourceRef.current;
    if (!owner) return;
    setGoneState({ pending: true, error: null });
    try {
      await enqueuePersistenceTask(async () => {
        const body = orderedParticipants().find(
          (participant) => participant.restore,
        );
        if (body?.restore) await body.restore(owner.restore);
        else await owner.restore(null);
      });
    } catch (error) {
      if (goneSourceRef.current !== owner) return;
      const request = makeAccessRequest(
        "explicit",
        `page-restore:${targetKey}`,
        m.page_gone_restore_intent(),
        () => restoreGoneSourceRef.current(),
      );
      const handled = await recovery.recoverFromError(error, request);
      if (!handled) console.error("Failed to restore the Page file:", error);
      setGoneState({
        pending: false,
        error: handled
          ? null
          : (owner.refusal(error) ?? m.page_gone_restore_error()),
      });
      return;
    }
    if (goneSourceRef.current !== owner) return;
    goneSourceRef.current = null;
    setGoneState(null);
    clearWriteBlock();
  }, [
    clearWriteBlock,
    enqueuePersistenceTask,
    makeAccessRequest,
    orderedParticipants,
    recovery,
    targetKey,
  ]);

  useEffect(() => {
    restoreGoneSourceRef.current = restoreGoneSource;
  }, [restoreGoneSource]);

  /** The body text with its unsaved edits, without frontmatter. */
  const goneSourceText = useCallback(() => {
    const body = orderedParticipants().find((participant) => participant.text);
    return body?.text?.() ?? goneSourceRef.current?.text() ?? "";
  }, [orderedParticipants]);

  const closeGoneSource = useCallback(async () => {
    const owner = goneSourceRef.current;
    if (!owner) return;
    await enqueuePersistenceTask(dropWork);
    clearWriteBlock();
    recovery.close();
    owner.close();
  }, [clearWriteBlock, dropWork, enqueuePersistenceTask, recovery]);

  return {
    closeGoneSource,
    discardChanges,
    flushPersistence,
    goneSourceText,
    goneState,
    holdGoneSource,
    holdsUnsavedWork,
    persistenceError,
    recoverSourceWriteError,
    recoverWriteError,
    registerPersistence,
    releaseGoneSource,
    reportSourceConflict,
    restoreGoneSource,
    retryPersistence,
    runMutation,
    settled,
    sourceConflict,
    writesHeld,
  };
}

function persistencePriority(kind: PagePersistenceKind) {
  return kind === "body" ? 100 : 200;
}
