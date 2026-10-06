import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SidebarMenuItem } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AgentSessionNavigationItem,
  agentSessionNavigationKey,
  agentSessionTargetFor,
  pinnableAgentSessionItem,
  useActiveAgentSessions,
  type AgentSession,
  type AgentSessionTarget,
} from "@/features/agent-sessions";
import {
  homeProjectUnavailableReason,
  type HomeProjectAvailability,
} from "@/features/home";
import {
  NavigationStoreProvider,
  navigationKeyId,
  useDescribedNavigationItem,
  useNavigationState,
  type NavigationItem,
  type NavigationKey,
  type NavigationResolvedItem,
} from "@/features/navigation";
import { useSpace, type SpaceInfo } from "@/features/space";
import { useInteractionWithin } from "@/shared/hooks/use-interaction-within";
import { useStableOrder } from "@/shared/hooks/use-stable-order";
import { cn } from "@/shared/lib/utils";
import * as m from "@/paraglide/messages.js";
import { useOpenSessionInMainArea } from "./agent-session-peek-host";
import {
  homeProjectRows,
  type HomeProjectRow,
} from "./home-project-items-model";
import { useMainAreaObject } from "./main-area-object";
import { useShellStore } from "./model";
import {
  NavigationArtifactItem,
  useOpenNavigationArtifact,
} from "./navigation-sidebar-items";
import { isSessionKey } from "./now-model";
import { TemporaryItem } from "./now-sidebar-section";
import {
  useInactiveProjectItems,
  useOpenInactiveProjectItem,
} from "./use-inactive-project-items";
import { useWorkingSetActions } from "./working-set";

interface HomeProjectItemsProps {
  project: SpaceInfo;
  availability: HomeProjectAvailability;
  onActivateContent: () => void;
  onBeforeNavigation: () => Promise<boolean>;
}

/**
 * The pinned and current objects under an expanded project of Home: the
 * live navigation of the active project, a separate read of any other.
 */
export function HomeProjectItems({
  project,
  availability,
  onActivateContent,
  onBeforeNavigation,
}: HomeProjectItemsProps) {
  const activeRootId = useSpace((state) => state.activeRootId);
  if (availability === "missing" || availability === "broken") {
    return <MutedRow>{homeProjectUnavailableReason(availability)}</MutedRow>;
  }
  if (project.id === activeRootId) {
    return (
      <ActiveProjectItems
        onActivateContent={onActivateContent}
        onBeforeNavigation={onBeforeNavigation}
      />
    );
  }
  return (
    <InactiveProjectItems
      key={project.path}
      project={project}
      availability={availability}
      onActivateContent={onActivateContent}
    />
  );
}

function ActiveProjectItems({
  onActivateContent,
  onBeforeNavigation,
}: {
  onActivateContent: () => void;
  onBeforeNavigation: () => Promise<boolean>;
}) {
  const loaded = useNavigationState((state) => state.loaded);
  const pinned = useNavigationState((state) => state.pinned);
  const kept = useNavigationState((state) => state.kept);
  const activeSessions = useActiveAgentSessions();
  const mainObject = useMainAreaObject();
  const described = useDescribedNavigationItem(
    mainObject?.kind === "artifact" ? mainObject.item : null,
  );
  const mainTarget = useShellStore((state) =>
    state.mainSurface === "session" ? state.mainSessionTarget : null,
  );
  const openArtifact = useOpenNavigationArtifact({
    onActivateContent,
    onBeforeNavigation,
  });
  const openSession = useOpenSessionInMainArea();
  const { closeItem } = useWorkingSetActions();

  if (!loaded) return <LoadingRows />;
  return (
    <ProjectRows
      rows={homeProjectRows({
        pinned,
        kept,
        activeSessions,
        main: { object: mainObject, described },
      })}
      mainKeyId={mainObject ? navigationKeyId(mainObject.item.key) : null}
      mainTarget={mainTarget}
      onOpenArtifact={(item) => void openArtifact(item)}
      onOpenSession={(session) =>
        void openSession(agentSessionTargetFor(session), session, {
          focus: false,
        })
      }
      onClose={(key) => void closeItem(key)}
    />
  );
}

function InactiveProjectItems({
  project,
  availability,
  onActivateContent,
}: {
  project: SpaceInfo;
  availability: HomeProjectAvailability;
  onActivateContent: () => void;
}) {
  const items = useInactiveProjectItems(project);
  return (
    <NavigationStoreProvider store={items.navigation}>
      <InactiveProjectRows
        project={project}
        availability={availability}
        items={items}
        onActivateContent={onActivateContent}
      />
    </NavigationStoreProvider>
  );
}

function InactiveProjectRows({
  project,
  availability,
  items: { sessions, spaceName, sessionSpaceName, refresh, close },
  onActivateContent,
}: {
  project: SpaceInfo;
  availability: HomeProjectAvailability;
  items: ReturnType<typeof useInactiveProjectItems>;
  onActivateContent: () => void;
}) {
  const loaded = useNavigationState((state) => state.loaded);
  const failed = useNavigationState((state) => state.failed);
  const pinned = useNavigationState((state) => state.pinned);
  const kept = useNavigationState((state) => state.kept);
  const open = useOpenInactiveProjectItem(
    project,
    availability,
    onActivateContent,
  );
  const listed = sessions.sessions ?? [];
  const read = loaded && sessions.sessions !== null;
  const readFailed = failed || sessions.failed;

  if (!read) {
    return readFailed ? <RetryRow onRetry={refresh} /> : <LoadingRows />;
  }
  return (
    <>
      <ProjectRows
        rows={homeProjectRows({
          pinned,
          kept,
          activeSessions: sessions.active,
          main: null,
        })}
        mainKeyId={null}
        mainTarget={null}
        onOpenArtifact={(item) => void open(item, null)}
        onOpenSession={(session) =>
          void open(
            { key: agentSessionNavigationKey(session), title: session.title },
            session,
          )
        }
        onClose={close}
        project={{ sessions: listed, spaceName: sessionSpaceName }}
        spaceName={(key) =>
          key.kind === "space" || isSessionKey(key)
            ? null
            : spaceName(key.spaceId)
        }
      />
      {readFailed && <RetryRow onRetry={refresh} />}
    </>
  );
}

/** The rows of a project's list, or the muted row of an empty project. */
function ProjectRows({
  rows,
  mainKeyId,
  mainTarget,
  onOpenArtifact,
  onOpenSession,
  onClose,
  project,
  spaceName,
}: {
  rows: HomeProjectRow[];
  mainKeyId: string | null;
  mainTarget: AgentSessionTarget | null;
  onOpenArtifact: (item: NavigationResolvedItem) => void;
  onOpenSession: (session: AgentSession) => void;
  onClose: (key: NavigationKey) => void;
  /** The list and Space names of a project that is not the active one. */
  project?: {
    sessions: readonly AgentSession[];
    spaceName: (session: AgentSession) => string | null;
  };
  spaceName?: (key: NavigationKey) => string | null;
}) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const hold = useInteractionWithin(
    element?.closest<HTMLElement>('[data-sidebar="sidebar"]') ?? element,
  );
  const active = rows.flatMap((row) =>
    row.kind === "active" ? [row.session] : [],
  );
  const activeOrder = useStableOrder(
    active.map((session) => session.id),
    hold,
  );
  const activeById = new Map(active.map((session) => [session.id, session]));
  const activeRows = activeOrder.flatMap((id) => {
    const session = activeById.get(id);
    return session ? [{ kind: "active" as const, session }] : [];
  });
  // Active sessions keep their place while the pointer is in the sidebar.
  const ordered = [
    ...rows.filter((row) => row.kind === "pinned"),
    ...activeRows,
    ...rows.filter((row) => row.kind === "kept" || row.kind === "temporary"),
  ];

  if (ordered.length === 0) {
    return <MutedRow>{m.home_project_items_empty()}</MutedRow>;
  }

  const sessionRow = (
    key: NavigationKey,
    title: string,
    stepItem: NavigationItem | null,
    extra: { onClose?: () => void; pinned?: boolean; keepable?: boolean } = {},
  ) => (
    <AgentSessionNavigationItem
      key={navigationKeyId(key)}
      navigationKey={key}
      fallbackTitle={title}
      mainTarget={mainTarget}
      onOpen={onOpenSession}
      stepItem={stepItem}
      project={project}
      {...extra}
    />
  );
  const artifactRow = (
    item: NavigationResolvedItem,
    extra: { onClose?: () => void; pinned?: boolean } = {},
  ) => {
    const id = navigationKeyId(item.key);
    return (
      <NavigationArtifactItem
        key={id}
        item={item}
        active={mainKeyId === id}
        onOpen={() => onOpenArtifact(item)}
        spaceName={spaceName?.(item.key)}
        {...extra}
      />
    );
  };

  return (
    <>
      {/* Locates the sidebar whose hover holds the order of active rows. */}
      <li ref={setElement} hidden aria-hidden />
      {ordered.map((row) => {
        switch (row.kind) {
          case "pinned":
            return isSessionKey(row.item.key)
              ? sessionRow(row.item.key, row.item.title, row.item, {
                  pinned: true,
                })
              : artifactRow(row.item, { pinned: true });
          case "active": {
            const item = pinnableAgentSessionItem(row.session);
            const key = agentSessionNavigationKey(row.session);
            return sessionRow(key, row.session.title, item, {
              keepable: true,
            });
          }
          case "kept": {
            const close = () => onClose(row.item.key);
            return isSessionKey(row.item.key)
              ? sessionRow(row.item.key, row.item.title, row.item, {
                  onClose: close,
                })
              : artifactRow(row.item, { onClose: close });
          }
          case "temporary":
            return (
              <TemporaryItem
                key={`temporary:${navigationKeyId(row.temporary.item.key)}`}
                temporary={row.temporary}
                mainTarget={mainTarget}
                onClose={() => onClose(row.temporary.item.key)}
              />
            );
        }
      })}
    </>
  );
}

function MutedRow({ children }: { children: ReactNode }) {
  return (
    <SidebarMenuItem>
      <div className="flex min-h-7 items-center px-2 py-1 text-xs text-sidebar-foreground/50">
        <span className="min-w-0 truncate">{children}</span>
      </div>
    </SidebarMenuItem>
  );
}

function RetryRow({ onRetry }: { onRetry: () => void }) {
  return (
    <SidebarMenuItem>
      <div className="flex min-h-7 items-center gap-2 px-2 py-1 text-xs text-sidebar-foreground/50">
        <span className="min-w-0 flex-1 truncate">
          {m.home_project_items_failed()}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={onRetry}
        >
          {m.app_retry()}
        </Button>
      </div>
    </SidebarMenuItem>
  );
}

function LoadingRows() {
  return (
    <>
      {[0, 1].map((index) => (
        <SidebarMenuItem key={index} aria-hidden>
          <div className="flex h-7 items-center gap-2 rounded-md px-2">
            <Skeleton className="size-4" />
            <Skeleton className={cn("h-3", index === 0 ? "w-24" : "w-32")} />
          </div>
        </SidebarMenuItem>
      ))}
    </>
  );
}
