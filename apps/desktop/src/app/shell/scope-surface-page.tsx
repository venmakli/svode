import { usePublishMainChangesTarget } from "@/features/changes";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { AgentContextSurface } from "@/features/agent-context";
import { ActorsSurface } from "@/features/actors";
import { RoutinesSurface } from "@/features/routines";
import {
  runCollectionNavigation,
  useCollectionDetailController,
} from "@/features/collection/app-shell";
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
  PageDetailProvider,
  PageSurfaceSessionProvider,
  ReadmeSurface,
  usePageSurfaceSession,
  usePageDetailContext,
} from "@/features/page/scope-surface";
import { useOpenPage } from "@/features/page/navigation";
import {
  ScopeOwnerHeader,
  ScopeSurfaceHost,
  type ScopeOpenIntent,
  type ScopeOwnerRef,
  type ScopePresentation,
} from "@/features/scope-surfaces";
import type { Page } from "@/features/page";
import { createScopeSurfaceContributions } from "./scope-surface-contributions";
import { useShellStore } from "./model";
import { createScopeContentRenderers } from "./scope-content-renderers";
import { CompactScopePeek } from "./compact-scope-peek";
import { ScopeOwnerActions } from "./scope-owner-actions";

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
  const detailController = useCollectionDetailController();
  const openSessionsSurface = useShellStore(
    (state) => state.openSessionsSurface,
  );
  const openSpaceSettings = useShellStore((state) => state.openSpaceSettings);
  const openRepositorySettings = useCallback(
    (repositoryPath: string) => openSpaceSettings(repositoryPath, "git"),
    [openSpaceSettings],
  );
  const openRoutineSession = useCallback(
    (target: { sessionId: string; launchId: string }) => {
      void runCollectionNavigation(detailController, () => {
        openSessionsSurface(target);
      });
    },
    [detailController, openSessionsSurface],
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
      openRepositorySettings,
      openRoutineSession,
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
        fallbackTitle={fallbackTitle}
        fallbackIcon={fallbackIcon}
        onOpenPath={openPath}
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
  useEffect(() => {
    if (detail.page && detail.page.path !== props.owner.readmePath)
      onContentPathChange?.(detail.page.path);
  }, [detail.page, props.owner.readmePath, onContentPathChange]);
  useEffect(
    () =>
      registerNavigationGuard?.(async () => {
        if (!(await detailController.prepareForNavigation())) return false;
        return pageSurface.prepareForNavigation();
      }),
    [detailController, pageSurface, registerNavigationGuard],
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
        <ScopeOwnerHeader
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
              <ScopeOwnerActions readOnly={pageSurface.readOnly} />
            )
          }
        />
      )}
      prepareForSurfaceChange={async () => {
        if (!(await detailController.prepareForNavigation())) return false;
        return pageSurface.prepareForNavigation();
      }}
    />
  );
}
