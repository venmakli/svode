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

import {
  ArtifactSurfaceTransitionSession,
  registerActiveContentDeactivation,
  resolveArtifactSurfaceHost,
  type ArtifactSurfaceTransitionStep,
} from "@/features/artifact";
import {
  useRepositoryAccess,
  useRepositoryAccessPreflight,
  type RepositoryAccessRequest,
} from "@/features/git";
import * as m from "@/paraglide/messages.js";

import {
  createPageSurfaceContributions,
  pageDefaultMode,
  type PageSurfaceMode,
} from "../model/page-surface";
import {
  usePagePersistence,
  type PagePersistenceFlush,
  type PagePersistenceKind,
} from "./use-page-persistence";

interface PageSurfaceSessionContextValue {
  contributions: ReturnType<typeof createPageSurfaceContributions>;
  currentMode: PageSurfaceMode;
  dismissRecovery: () => void;
  modePending: boolean;
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
  requestMode: (mode: PageSurfaceMode) => Promise<void>;
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
  const transitionSessionRef = useRef(new ArtifactSurfaceTransitionSession());
  const [mode, setMode] = useState<PageSurfaceMode | null>(() =>
    access.snapshot ? pageDefaultMode(access.snapshot.status) : null,
  );
  const [modePending, setModePending] = useState(false);
  const modePendingRef = useRef(false);
  useEffect(() => {
    if (mode) return;
    const nextMode = access.snapshot
      ? pageDefaultMode(access.snapshot.status)
      : access.error
        ? "view"
        : null;
    if (!nextMode) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setMode(nextMode);
    });
    return () => {
      cancelled = true;
    };
  }, [access.error, access.snapshot, mode]);

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
    reportPersistenceError,
    retryPersistence,
    runMutation,
  } = usePagePersistence({
    makeAccessRequest,
    recovery,
    targetKey,
  });

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

  const requestMode = useCallback(
    async (nextMode: PageSurfaceMode) => {
      const currentMode = mode ?? pageDefaultMode(access.snapshot?.status);
      if (nextMode === currentMode || modePendingRef.current) return;
      modePendingRef.current = true;
      setModePending(true);
      const result = await transitionSessionRef.current.transition({
        deactivate:
          currentMode === "edit"
            ? async (): Promise<ArtifactSurfaceTransitionStep> =>
                (await flushPersistence()) ? "ready" : "blocked"
            : undefined,
        activate:
          nextMode === "edit"
            ? async (): Promise<ArtifactSurfaceTransitionStep> => {
                const status = access.snapshot?.status;
                if (status === "local" || status === "writable") {
                  return "ready";
                }
                await recovery.request(
                  makeAccessRequest(
                    "automatic",
                    `page-edit:${targetKey}`,
                    m.page_surface_mode_edit(),
                    () => {
                      setMode("edit");
                    },
                  ),
                );
                return "blocked";
              }
            : undefined,
      });
      if (result.status === "activated") {
        setMode(nextMode);
      } else if (result.status === "error") {
        reportPersistenceError();
      }
      modePendingRef.current = false;
      setModePending(false);
    },
    [
      access.snapshot?.status,
      flushPersistence,
      makeAccessRequest,
      mode,
      recovery,
      reportPersistenceError,
      targetKey,
    ],
  );

  const contributions = useMemo(
    () =>
      createPageSurfaceContributions({
        editLabel: m.page_surface_mode_edit(),
        mode,
        status: access.snapshot?.status,
        viewLabel: m.page_surface_mode_view(),
      }),
    [access.snapshot?.status, mode],
  );
  const host = resolveArtifactSurfaceHost(contributions, mode);
  const currentMode = host.currentId as PageSurfaceMode;

  const value = useMemo<PageSurfaceSessionContextValue>(
    () => ({
      contributions,
      currentMode,
      dismissRecovery,
      modePending: modePending || mode === null,
      persistenceError,
      prepareForNavigation,
      readOnly: currentMode !== "edit" || mode === null,
      recoverWriteError,
      recovery,
      registerPersistence,
      requestMode,
      retryPersistence,
      runMutation,
    }),
    [
      contributions,
      currentMode,
      dismissRecovery,
      mode,
      modePending,
      persistenceError,
      prepareForNavigation,
      recoverWriteError,
      recovery,
      registerPersistence,
      requestMode,
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
