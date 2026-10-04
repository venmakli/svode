import { usePublishMainChangesTarget } from "@/features/changes";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { AgentContextSurface } from "@/features/agent-context";
import { AgentSessionsSurface } from "@/features/agent-sessions";
import { ActorsSurface } from "@/features/actors";
import { RoutinesSurface } from "@/features/routines";
import { useCollectionDetailController } from "@/features/collection/app-shell";
import {
  CollectionViewsSurface,
  type CollectionViewsSurfaceProps,
} from "@/features/collection/scope-surface";
import type {
  CalendarScope,
  CollectionPeekSurfaceState,
  CollectionRouteState,
} from "@/features/collection/app-shell";
import {
  PageDetailHeader,
  PageDetailProvider,
  PageSurfaceSessionProvider,
  ReadmeSurface,
  usePageSurfaceSession,
  usePageDetailContext,
} from "@/features/page/scope-surface";
import { useOpenPage } from "@/features/page/navigation";
import {
  ScopeSurfaceHost,
  type ScopeOpenIntent,
  type ScopeOwnerRef,
  type ScopePresentation,
} from "@/features/scope-surfaces";
import type { Page } from "@/features/page";
import { useSpace } from "@/features/space";
import { createScopeSurfaceContributions } from "./scope-surface-contributions";
import { useShellStore } from "./model";
import { createScopeContentRenderers } from "./scope-content-renderers";
import { CompactScopePeek } from "./compact-scope-peek";
import { ScopeOwnerActions } from "./scope-owner-actions";
import { scopeOwnerNavigationItem } from "./scope-owner-navigation";
import { useOpenSessionRoutine } from "./open-session-routine";

interface ScopeSurfacePageProps {
  owner: ScopeOwnerRef;
  presentation: ScopePresentation;
  routeState?: CollectionViewsSurfaceProps["routeState"];
  headerActions?: ReactNode;
  renderHeaderActions?: (page: Page, readOnly: boolean) => ReactNode;
  metadataBefore?: ReactNode;
  onContentPathChange?: (path: string) => void;
  openIntent?: ScopeOpenIntent;
  openRequestKey?: number;
  previousOwnerKey?: ScopeOwnerRef["ownerKey"];
  sessionKey?: string | number;
  compactSurfaceState?: CollectionPeekSurfaceState;
  fallbackTitle?: string;
  fallbackIcon?: string | null;
  registerNavigationGuard?: (guard: () => Promise<boolean>) => () => void;
  onPageGone?: () => void;
}

export function ScopeSurfacePage({
  owner,
  presentation,
  routeState,
  headerActions,
  renderHeaderActions,
  metadataBefore,
  onContentPathChange,
  openIntent,
  openRequestKey,
  previousOwnerKey,
  sessionKey,
  compactSurfaceState,
  fallbackTitle,
  fallbackIcon,
  registerNavigationGuard,
  onPageGone,
}: ScopeSurfacePageProps) {
  const [compactViewName, setCompactViewName] = useState<string | null>(null);
  const [compactCalendarScope, setCompactCalendarScope] =
    useState<CalendarScope | null>(null);
  const [localCompactSurfaceId, setLocalCompactSurfaceId] =
    useState<CollectionPeekSurfaceState["surfaceId"]>("readme");
  const compactRouteState = useMemo<CollectionRouteState>(
    () => ({
      viewName: compactViewName,
      onViewNameChange: setCompactViewName,
      calendarScope: compactCalendarScope,
      onCalendarScopeChange: setCompactCalendarScope,
    }),
    [compactCalendarScope, compactViewName],
  );
  const collectionRouteState =
    presentation === "compact" ? (routeState ?? compactRouteState) : routeState;
  const openPage = useOpenPage();
  const openSessionPeek = useShellStore((state) => state.openSessionPeek);
  const openSessionDraftPeek = useShellStore(
    (state) => state.openSessionDraftPeek,
  );
  const openSpaceSettings = useShellStore((state) => state.openSpaceSettings);
  const openAppSettings = useShellStore((state) => state.openAppSettings);
  const openProvidersSettings = useCallback(
    () => openAppSettings("providers"),
    [openAppSettings],
  );
  const openRepositorySettings = useCallback(
    (repositoryPath: string) => openSpaceSettings(repositoryPath, "git"),
    [openSpaceSettings],
  );
  const openSessionRoutine = useOpenSessionRoutine();
  // A session opened from the routine detail is its child peek.
  const openRoutineSession = useCallback(
    ({ sessionId, launchId }: { sessionId: string; launchId: string }) =>
      openSessionPeek({ sessionId, launchId }),
    [openSessionPeek],
  );
  const openPath = useCallback(
    (path: string, spaceId?: string | null) =>
      openPage(path, spaceId ?? owner.spaceId),
    [openPage, owner.spaceId],
  );
  const createContributions = useCallback(
    (readOnly: boolean) =>
      createScopeSurfaceContributions({
        ...createScopeContentRenderers({ readOnly, name: fallbackTitle }),
        actors: (context) => (
          <ActorsSurface
            {...context}
            readOnly={readOnly}
            repositoryOwnerName={fallbackTitle}
            onOpenRepositorySettings={openRepositorySettings}
          />
        ),
        context: (context) => <AgentContextSurface {...context} />,
        routines: (context) => (
          <RoutinesSurface
            {...context}
            readOnly={readOnly}
            onOpenSession={openRoutineSession}
          />
        ),
        sessions: (context) => (
          <AgentSessionsSurface
            {...context}
            onOpenSession={openSessionPeek}
            onOpenNewSessionDraft={openSessionDraftPeek}
            onOpenAppSettings={openProvidersSettings}
            onOpenRoutine={openSessionRoutine}
          />
        ),
        readme: () => <ReadmeSurface />,
        collection: () => (
          <CollectionViewsSurface
            readOnly={readOnly}
            spacePath={owner.spacePath}
            projectPath={owner.projectPath}
            pagePath={owner.readmePath}
            spaceId={owner.spaceId}
            routeState={collectionRouteState}
            renderPeek={(context) => (
              <CompactScopePeek key={context.sessionKey} {...context} />
            )}
          />
        ),
      }),
    [
      collectionRouteState,
      fallbackTitle,
      openProvidersSettings,
      openRepositorySettings,
      openRoutineSession,
      openSessionDraftPeek,
      openSessionPeek,
      openSessionRoutine,
      owner,
    ],
  );
  return (
    <PageSurfaceSessionProvider
      displayName={fallbackTitle ?? owner.ownerPath}
      displayPath={owner.readmePath}
      onOpenRepositorySettings={openRepositorySettings}
      registerGlobalDeactivation={presentation === "full"}
      spacePath={owner.spacePath}
      targetKey={String(sessionKey ?? previousOwnerKey ?? owner.ownerKey)}
    >
      <PageDetailProvider
        spacePath={owner.spacePath}
        projectPath={owner.projectPath}
        spaceId={owner.spaceId}
        readmePath={owner.readmePath}
        ownerPath={owner.ownerPath}
        target={
          owner.identityKind === "page-file" ||
          owner.identityKind === "page-directory"
            ? "page"
            : "readme"
        }
        fallbackTitle={fallbackTitle}
        fallbackIcon={fallbackIcon}
        onOpenPath={openPath}
        onPageGone={onPageGone}
      >
        <ScopePageSurfaceHost
          owner={owner}
          presentation={presentation}
          createContributions={createContributions}
          registerNavigationGuard={registerNavigationGuard}
          headerActions={headerActions}
          renderHeaderActions={renderHeaderActions}
          metadataBefore={metadataBefore}
          onContentPathChange={onContentPathChange}
          openIntent={openIntent}
          openRequestKey={openRequestKey}
          previousOwnerKey={previousOwnerKey}
          sessionKey={sessionKey}
          compactSurfaceId={
            compactSurfaceState?.surfaceId ?? localCompactSurfaceId
          }
          onCompactSurfaceIdChange={
            compactSurfaceState?.onSurfaceIdChange ?? setLocalCompactSurfaceId
          }
        />
      </PageDetailProvider>
    </PageSurfaceSessionProvider>
  );
}

function ScopePageSurfaceHost({
  createContributions,
  headerActions,
  renderHeaderActions,
  metadataBefore,
  onContentPathChange,
  registerNavigationGuard,
  ...props
}: Omit<ComponentProps<typeof ScopeSurfaceHost>, "contributions" | "header"> & {
  createContributions: (
    readOnly: boolean,
  ) => ComponentProps<typeof ScopeSurfaceHost>["contributions"];
  headerActions?: ReactNode;
  renderHeaderActions?: (page: Page, readOnly: boolean) => ReactNode;
  metadataBefore?: ReactNode;
  onContentPathChange?: (path: string) => void;
  registerNavigationGuard?: (guard: () => Promise<boolean>) => () => void;
}) {
  const pageSurface = usePageSurfaceSession();
  const detailController = useCollectionDetailController();
  const detail = usePageDetailContext();
  const activeRootId = useSpace((state) => state.activeRootId);
  const pagePath = detail.page?.path ?? null;
  const readmePath = props.owner.readmePath;
  // A path transition of this Page is handed to the host once: neither a new
  // callback identity nor an owner still resolving the new path repeats it.
  const pathHandoffRef = useRef({ pagePath, readmePath, hostPath: readmePath });
  useEffect(() => {
    const handoff = pathHandoffRef.current;
    if (handoff.readmePath !== readmePath) {
      handoff.readmePath = readmePath;
      handoff.hostPath = readmePath;
    }
    if (handoff.pagePath === pagePath) return;
    handoff.pagePath = pagePath;
    if (!pagePath || pagePath === handoff.hostPath) return;
    handoff.hostPath = pagePath;
    onContentPathChange?.(pagePath);
  }, [pagePath, readmePath, onContentPathChange]);
  useEffect(
    () =>
      registerNavigationGuard?.(() => pageSurface.prepareToLeave()),
    [pageSurface, registerNavigationGuard],
  );
  usePublishMainChangesTarget(
    props.presentation === "full"
      ? {
          kind:
            props.owner.identityKind === "registered-space"
              ? props.owner.spacePath === props.owner.projectPath
                ? "project"
                : "space"
              : "owner",
          sourceShape: "directory",
          spacePath: props.owner.spacePath,
          projectPath: props.owner.projectPath,
          sessionKey: props.openRequestKey,
          path: props.owner.readmePath,
          name: detail.page?.meta.title ?? detail.fallbackTitle,
        }
      : null,
  );
  const contributions = useMemo(
    () => createContributions(pageSurface.readOnly),
    [createContributions, pageSurface.readOnly],
  );
  return (
    <ScopeSurfaceHost
      {...props}
      contributions={contributions}
      header={(activeSurfaceId) => (
        <PageDetailHeader
          readOnly={pageSurface.readOnly}
          metadataBefore={metadataBefore}
          presentation={props.presentation}
          showReadError={activeSurfaceId !== "readme"}
          actions={
            detail.page && renderHeaderActions ? (
              renderHeaderActions(detail.page, pageSurface.readOnly)
            ) : headerActions !== undefined ? (
              headerActions
            ) : (
              <ScopeOwnerActions
                pinItem={scopeOwnerNavigationItem(props.owner, activeRootId, {
                  title: detail.page?.meta.title ?? props.owner.ownerPath,
                  icon: detail.page?.meta.icon ?? null,
                })}
                readOnly={pageSurface.readOnly}
              />
            )
          }
        />
      )}
      prepareForSurfaceChange={async () => {
        if (!(await detailController.close())) return false;
        return pageSurface.prepareForNavigation();
      }}
    />
  );
}
