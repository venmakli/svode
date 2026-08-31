import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { registerActiveContentDeactivation } from "@/features/artifact";
import {
  repositoryAccessIsEditable,
  useRepositoryAccess,
  useRepositoryAccessPreflight,
  type RepositoryAccessRequest,
} from "@/features/git";
import {
  usePagePersistence,
  type PagePersistenceFlush,
  type PagePersistenceKind,
} from "./use-page-persistence";

interface PageSurfaceSessionContextValue {
  dismissRecovery: () => void;
  persistenceError: string | null;
  readOnly: boolean;
  recovery: ReturnType<typeof useRepositoryAccessPreflight>;
  prepareForNavigation: () => Promise<boolean>;
  recoverWriteError: (
    error: unknown,
    retry: () => Promise<void>,
  ) => Promise<boolean>;
  registerPersistence: (
    kind: PagePersistenceKind,
    flush: PagePersistenceFlush,
  ) => () => void;
  retryPersistence: () => Promise<void>;
  runMutation: (operation: () => Promise<void>) => Promise<void>;
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
    dismissRecovery,
    flushPersistence,
    persistenceError,
    recoverWriteError,
    registerPersistence,
    retryPersistence,
    runMutation,
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

  useEffect(() => {
    if (!registerGlobalDeactivation) return;
    return registerActiveContentDeactivation(async () =>
      (await prepareForNavigation()) ? "ready" : "blocked",
    );
  }, [prepareForNavigation, registerGlobalDeactivation]);

  const value = useMemo<PageSurfaceSessionContextValue>(
    () => ({
      dismissRecovery,
      persistenceError,
      prepareForNavigation,
      readOnly,
      recoverWriteError,
      recovery,
      registerPersistence,
      retryPersistence,
      runMutation,
    }),
    [
      dismissRecovery,
      persistenceError,
      prepareForNavigation,
      readOnly,
      recoverWriteError,
      recovery,
      registerPersistence,
      retryPersistence,
      runMutation,
    ],
  );

  return (
    <PageSurfaceSessionContext.Provider value={value}>
      {children}
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
