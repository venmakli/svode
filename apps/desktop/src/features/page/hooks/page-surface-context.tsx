import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import {
  markActiveContentAwaitingDecision,
  registerActiveContentDeactivation,
} from "@/features/artifact";
import {
  repositoryAccessIsEditable,
  useRepositoryAccess,
  useRepositoryAccessPreflight,
  type RepositoryAccessRequest,
} from "@/features/git";
import * as m from "@/paraglide/messages.js";
import type { PageSourceConflict } from "../model/source-conflict";
import {
  PageDiscardDialog,
  type PageDiscardConfirmation,
} from "../ui/page-discard-dialog";
import {
  usePagePersistence,
  type PagePersistenceKind,
  type PagePersistenceParticipant,
} from "./use-page-persistence";

interface PageSurfaceSessionContextValue {
  persistenceError: string | null;
  readOnly: boolean;
  recovery: ReturnType<typeof useRepositoryAccessPreflight>;
  /** Saves pending work before a non-leaving step; false while it is blocked. */
  prepareForNavigation: () => Promise<boolean>;
  /** Saves pending work before leaving the Page, asking the user when blocked. */
  prepareToLeave: () => Promise<boolean>;
  recoverWriteError: (
    error: unknown,
    retry: () => Promise<void>,
  ) => Promise<boolean>;
  registerPersistence: (
    kind: PagePersistenceKind,
    participant: PagePersistenceParticipant,
  ) => () => void;
  /** The inline recovery the user returns to after keeping a blocked draft. */
  registerRecoveryElement: (element: HTMLElement | null) => void;
  reportSourceConflict: (conflict: PageSourceConflict | null) => void;
  requestDiscard: () => void;
  retryPersistence: () => Promise<void>;
  runMutation: (operation: () => Promise<void>) => Promise<void>;
  sourceConflict: PageSourceConflict | null;
}

const PageSurfaceSessionContext =
  createContext<PageSurfaceSessionContextValue | null>(null);

interface PageSurfaceSessionProviderProps {
  children: ReactNode;
  displayName: string;
  displayPath: string;
  onOpenRepositorySettings?: (repositoryPath: string) => void;
  registerGlobalDeactivation?: boolean;
  spacePath: string;
  targetKey: string;
}

export function PageSurfaceSessionProvider(
  props: PageSurfaceSessionProviderProps,
) {
  return <PageSurfaceSession key={props.targetKey} {...props} />;
}

function PageSurfaceSession({
  children,
  displayName,
  displayPath,
  onOpenRepositorySettings,
  registerGlobalDeactivation = false,
  spacePath,
  targetKey,
}: PageSurfaceSessionProviderProps) {
  const access = useRepositoryAccess(spacePath);
  const recovery = useRepositoryAccessPreflight();
  const accessReadOnly = !repositoryAccessIsEditable(access);
  const [readOnly, setReadOnly] = useState(accessReadOnly);

  const makeAccessRequest = useCallback(
    (
      continuation: RepositoryAccessRequest["continuation"],
      intentKey: string,
      intentLabel: string,
      continueIntent: () => void | Promise<void>,
    ): RepositoryAccessRequest => ({
      continuation,
      continue: continueIntent,
      intentKey,
      intentLabel,
      placement: "inline",
      targets: [
        {
          displayName,
          displayPath,
          repositoryPath: spacePath,
          openSettings: onOpenRepositorySettings
            ? () => onOpenRepositorySettings(spacePath)
            : undefined,
        },
      ],
    }),
    [displayName, displayPath, onOpenRepositorySettings, spacePath],
  );
  const {
    discardChanges,
    flushPersistence,
    persistenceError,
    recoverWriteError,
    registerPersistence,
    reportSourceConflict,
    retryPersistence,
    runMutation,
    sourceConflict,
  } = usePagePersistence({
    makeAccessRequest,
    recovery,
    targetKey,
  });

  useEffect(() => {
    if (accessReadOnly === readOnly) return;
    if (accessReadOnly) {
      commitActivePageEdit();
      void flushPersistence();
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setReadOnly(accessReadOnly);
    });
    return () => {
      cancelled = true;
    };
  }, [accessReadOnly, flushPersistence, readOnly]);

  const prepareForNavigation = useCallback(
    async () => flushPersistence(),
    [flushPersistence],
  );

  const [confirmation, setConfirmationState] =
    useState<PageDiscardConfirmation | null>(null);
  const confirmationRef = useRef<PageDiscardConfirmation | null>(null);
  const setConfirmation = useCallback(
    (next: PageDiscardConfirmation | null) => {
      confirmationRef.current = next;
      setConfirmationState(next);
    },
    [],
  );
  const leaveRef = useRef<Promise<boolean> | null>(null);
  const recoveryElementRef = useRef<HTMLElement | null>(null);
  const registerRecoveryElement = useCallback((element: HTMLElement | null) => {
    recoveryElementRef.current = element;
  }, []);

  const prepareToLeave = useCallback(async () => {
    if (leaveRef.current) return leaveRef.current;
    if (await flushPersistence()) return true;
    // A blocked save never cancels the navigation silently: the user keeps
    // the draft or discards it and continues to the requested target.
    leaveRef.current ??= new Promise<boolean>((resolve) => {
      markActiveContentAwaitingDecision();
      // A leave supersedes an open discard question from the recovery.
      confirmationRef.current?.resolve(false);
      setConfirmation({ kind: "leave", resolve });
    }).finally(() => {
      leaveRef.current = null;
    });
    return leaveRef.current;
  }, [flushPersistence, setConfirmation]);

  const requestDiscard = useCallback(() => {
    if (confirmationRef.current) return;
    setConfirmation({ kind: "discard", resolve: () => undefined });
  }, [setConfirmation]);

  const resolveConfirmation = useCallback(
    async (discard: boolean) => {
      const current = confirmationRef.current;
      if (!current) return;
      setConfirmation(null);
      if (!discard) {
        current.resolve(false);
        return;
      }
      try {
        await discardChanges();
        current.resolve(true);
      } catch (error) {
        console.error("Failed to discard Page changes:", error);
        toast.error(m.page_discard_error());
        current.resolve(false);
      }
    },
    [discardChanges, setConfirmation],
  );

  useEffect(() => {
    if (!registerGlobalDeactivation) return;
    return registerActiveContentDeactivation(async () =>
      (await prepareToLeave()) ? "ready" : "blocked",
    );
  }, [prepareToLeave, registerGlobalDeactivation]);

  const value = useMemo<PageSurfaceSessionContextValue>(
    () => ({
      persistenceError,
      prepareForNavigation,
      prepareToLeave,
      readOnly,
      recoverWriteError,
      recovery,
      registerPersistence,
      registerRecoveryElement,
      reportSourceConflict,
      requestDiscard,
      retryPersistence,
      runMutation,
      sourceConflict,
    }),
    [
      persistenceError,
      prepareForNavigation,
      prepareToLeave,
      readOnly,
      recoverWriteError,
      recovery,
      registerPersistence,
      registerRecoveryElement,
      reportSourceConflict,
      requestDiscard,
      retryPersistence,
      runMutation,
      sourceConflict,
    ],
  );

  return (
    <PageSurfaceSessionContext.Provider value={value}>
      {children}
      <PageDiscardDialog
        confirmation={confirmation}
        persistenceError={persistenceError}
        recovery={recovery}
        sourceConflict={sourceConflict}
        onResolve={(discard) => void resolveConfirmation(discard)}
        onKeepFocus={() => recoveryElementRef.current?.focus()}
      />
    </PageSurfaceSessionContext.Provider>
  );
}

export function usePageSurfaceSession() {
  const context = useContext(PageSurfaceSessionContext);
  if (!context)
    throw new Error("Page surface requires PageSurfaceSessionProvider");
  return context;
}

export function useOptionalPageSurfaceSession() {
  return useContext(PageSurfaceSessionContext);
}

function commitActivePageEdit() {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return;
  if (
    !activeElement.matches(
      'input:not([readonly]), textarea:not([readonly]), [contenteditable="true"]',
    )
  ) {
    return;
  }
  activeElement.blur();
}
