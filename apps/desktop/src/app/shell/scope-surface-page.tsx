import {
  useCallback,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { AgentContextSurface } from "@/features/agent-context";
import { ActorsSurface } from "@/features/actors";
import {
  attachmentOwnerFromScopeOwner,
  AttachmentsSurface,
} from "@/features/attachments";
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
} from "@/features/page/scope-surface";
import { useOpenPage } from "@/features/page/navigation";
import {
  createCollectionDirectoryOwner,
  ScopeOwnerHeader,
  ScopeSurfaceHost,
  type ScopeOpenIntent,
  type ScopeOwnerRef,
  type ScopePresentation,
} from "@/features/scope-surfaces";
import type { Page } from "@/features/page";
import { createScopeSurfaceContributions } from "./scope-surface-contributions";
import { useShellStore } from "./model";
import { ScopeOwnerActions } from "./scope-owner-actions";

interface ScopeSurfacePageProps {
  owner: ScopeOwnerRef;
  presentation: ScopePresentation;
  routeState?: CollectionViewsSurfaceProps["routeState"];
  headerActions?: ReactNode;
  openIntent?: ScopeOpenIntent;
  openRequestKey?: number;
  previousOwnerKey?: ScopeOwnerRef["ownerKey"];
  sessionKey?: string | number;
  compactSurfaceState?: CollectionPeekSurfaceState;
  fallbackTitle?: string;
  fallbackIcon?: string | null;
}

export function ScopeSurfacePage({
  owner,
  presentation,
  routeState,
  headerActions,
  openIntent,
  openRequestKey,
  previousOwnerKey,
  sessionKey,
  compactSurfaceState,
  fallbackTitle,
  fallbackIcon,
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
  const renderNested = useCallback(
    (
      page: Page,
      actions: ReactNode,
      nestedRouteState: CollectionRouteState,
      nestedSurfaceState: CollectionPeekSurfaceState,
      nestedSessionKey: string,
    ) => {
      const nestedOwner = createCollectionDirectoryOwner({
        spaceId: owner.spaceId,
        spacePath: owner.spacePath,
        projectPath: owner.projectPath,
        ownerPath: collectionOwnerPath(page.path),
        status: "ready",
        hasSchema: true,
      });
      return (
        <ScopeSurfacePage
          owner={nestedOwner}
          presentation="compact"
          routeState={nestedRouteState}
          compactSurfaceState={nestedSurfaceState}
          headerActions={actions}
          sessionKey={nestedSessionKey}
        />
      );
    },
    [owner.projectPath, owner.spaceId, owner.spacePath],
  );
  const createContributions = useCallback(
    (readOnly: boolean) =>
      createScopeSurfaceContributions({
        attachments: (context) => (
          <AttachmentsSurface
            owner={attachmentOwnerFromScopeOwner(context.owner)}
            readOnly={readOnly}
          />
        ),
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
            renderNested={renderNested}
          />
        ),
      }),
    [
      collectionRouteState,
      fallbackTitle,
      openRepositorySettings,
      openRoutineSession,
      owner,
      renderNested,
    ],
  );
  return (
    <PageSurfaceSessionProvider
      displayName={fallbackTitle ?? owner.ownerPath}
      displayPath={owner.readmePath}
      onOpenRepositorySettings={openRepositorySettings}
      registerGlobalDeactivation={presentation === "full"}
      spacePath={owner.spacePath}
      targetKey={previousOwnerKey ?? owner.ownerKey}
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
          headerActions={headerActions}
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
  ...props
}: Omit<ComponentProps<typeof ScopeSurfaceHost>, "contributions" | "header"> & {
  createContributions: (
    readOnly: boolean,
  ) => ComponentProps<typeof ScopeSurfaceHost>["contributions"];
  headerActions?: ReactNode;
}) {
  const pageSurface = usePageSurfaceSession();
  const contributions = useMemo(
    () => createContributions(pageSurface.readOnly),
    [createContributions, pageSurface.readOnly],
  );
  return (
    <ScopeSurfaceHost
      {...props}
      contributions={contributions}
      header={() => (
        <ScopeOwnerHeader
          readOnly={pageSurface.readOnly}
          actions={
            headerActions ?? (
              <ScopeOwnerActions readOnly={pageSurface.readOnly} />
            )
          }
        />
      )}
      prepareForSurfaceChange={(currentSurfaceId) =>
        currentSurfaceId === "readme"
          ? pageSurface.prepareForNavigation()
          : true
      }
    />
  );
}

function collectionOwnerPath(path: string) {
  const normalized = path.replaceAll("\\", "/");
  return normalized.replace(/\/readme\.md$/i, "");
}
