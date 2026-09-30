import { useState, type ReactNode } from "react";
import { Ellipsis, SquareX, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarGroupAction } from "@/components/ui/sidebar";
import {
  AgentSessionNavigationItem,
  CloseSessionTerminalsDialog,
  agentSessionNavigationKey,
  agentSessionTargetFor,
  pinnableAgentSessionItem,
  useActiveAgentSessions,
  useSessionTerminals,
  type AgentSession,
  type AgentSessionTarget,
  type SessionTerminals,
} from "@/features/agent-sessions";
import {
  KeepMenuItem,
  NavigationSidebarGroup,
  PinMenuItem,
  navigationKeyId,
  useDescribedNavigationItem,
  useKeepInNow,
  useNavigationState,
  type NavigationItem,
} from "@/features/navigation";
import { useInteractionWithin } from "@/shared/hooks/use-interaction-within";
import { useStableOrder } from "@/shared/hooks/use-stable-order";
import { useShellStore } from "./model";
import { useOpenSessionInMainArea } from "./agent-session-peek-host";
import { useMainAreaObject } from "./main-area-object";
import { composeNow, isSessionKey, type NowTemporary } from "./now-model";
import {
  NavigationArtifactItem,
  useOpenNavigationArtifact,
} from "./navigation-sidebar-items";
import { useWorkingSetActions } from "./working-set";
import * as m from "@/paraglide/messages.js";

interface NowSidebarSectionProps {
  onActivateContent: () => void;
  onBeforeNavigation: () => Promise<boolean>;
}

/**
 * "Now" of the main sidebar: active sessions, then the kept objects in keep
 * order, then the temporary main area object. An object pinned or shown
 * higher up is not repeated. Hidden while empty, unless session terminals
 * are open: its menu closes them.
 */
export function NowSidebarSection({
  onActivateContent,
  onBeforeNavigation,
}: NowSidebarSectionProps) {
  const pinned = useNavigationState((state) => state.pinned);
  const kept = useNavigationState((state) => state.kept);
  const sessions = useActiveAgentSessions();
  const mainTarget = useShellStore((state) =>
    state.mainSurface === "session" ? state.mainSessionTarget : null,
  );
  const mainObject = useMainAreaObject();
  const mainKeyId = mainObject ? navigationKeyId(mainObject.item.key) : null;
  const described = useDescribedNavigationItem(
    mainObject?.kind === "artifact" ? mainObject.item : null,
  );
  const {
    active: activeSessions,
    kept: keptItems,
    temporary,
  } = composeNow({
    pinned,
    kept,
    activeSessions: sessions,
    mainObject,
    described,
  });
  const openArtifactItem = useOpenNavigationArtifact({
    onActivateContent,
    onBeforeNavigation,
  });
  const openSession = useOpenSessionInMainArea();
  const { closeItem, closeAll } = useWorkingSetActions();
  const sessionTerminals = useSessionTerminals();
  const [element, setElement] = useState<HTMLElement | null>(null);
  const hold = useInteractionWithin(
    element?.closest<HTMLElement>('[data-sidebar="sidebar"]') ?? element,
  );

  const activeOrder = useStableOrder(
    activeSessions.map((session) => session.id),
    hold,
  );
  const activeById = new Map(activeSessions.map((s) => [s.id, s]));

  if (
    activeSessions.length === 0 &&
    keptItems.length === 0 &&
    !temporary &&
    sessionTerminals.count === 0
  ) {
    return null;
  }

  const openSessionHere = (session: AgentSession) =>
    void openSession(agentSessionTargetFor(session), session, {
      focus: false,
    });

  return (
    <div ref={setElement}>
      <NavigationSidebarGroup
        id="now"
        label={m.navigation_now()}
        action={
          <NowMenu
            canCloseAll={kept.length > 0 || temporary !== null}
            onCloseAll={() => void closeAll(Boolean(temporary))}
            sessionTerminals={sessionTerminals}
          />
        }
      >
        {activeOrder.map((id) => {
          const session = activeById.get(id);
          if (!session) return null;
          const item = pinnableAgentSessionItem(session);
          return (
            <AgentSessionNavigationItem
              key={`active:${id}`}
              navigationKey={agentSessionNavigationKey(session)}
              fallbackTitle={session.title}
              mainTarget={mainTarget}
              onOpen={openSessionHere}
              menu={
                <>
                  <PinMenuItem item={item} />
                  <KeepMenuItem item={item} />
                </>
              }
            />
          );
        })}
        {keptItems.map((item) => {
          const id = navigationKeyId(item.key);
          const close = () => void closeItem(item.key);
          const menu = <ItemMenu item={item} onClose={close} />;
          if (isSessionKey(item.key)) {
            return (
              <AgentSessionNavigationItem
                key={id}
                navigationKey={item.key}
                fallbackTitle={item.title}
                mainTarget={mainTarget}
                onOpen={openSessionHere}
                menu={menu}
                onClose={close}
              />
            );
          }
          return (
            <NavigationArtifactItem
              key={id}
              item={item}
              active={mainKeyId === id}
              onOpen={() => void openArtifactItem(item)}
              menu={menu}
              onClose={close}
            />
          );
        })}
        {temporary && (
          <TemporaryItem
            temporary={temporary}
            mainTarget={mainTarget}
            onClose={() => void closeItem(temporary.item.key)}
          />
        )}
      </NavigationSidebarGroup>
    </div>
  );
}

function TemporaryItem({
  temporary: { item, keepItem },
  mainTarget,
  onClose,
}: {
  temporary: NowTemporary;
  mainTarget: AgentSessionTarget | null;
  onClose: () => void;
}) {
  const { available, keep } = useKeepInNow(keepItem);
  const onKeep = available ? keep : undefined;
  const menu = <ItemMenu item={keepItem} onClose={onClose} keepable />;
  if (isSessionKey(item.key)) {
    return (
      <AgentSessionNavigationItem
        navigationKey={item.key}
        fallbackTitle={item.title}
        mainTarget={mainTarget}
        onOpen={() => undefined}
        menu={menu}
        onClose={onClose}
        temporary
        onKeep={onKeep}
      />
    );
  }
  return (
    <NavigationArtifactItem
      item={item}
      active
      onOpen={() => undefined}
      menu={menu}
      onClose={onClose}
      temporary
      onKeep={onKeep}
    />
  );
}

function ItemMenu({
  item,
  onClose,
  keepable = false,
}: {
  item: NavigationItem | null;
  onClose: () => void;
  keepable?: boolean;
}): ReactNode {
  return (
    <>
      <PinMenuItem item={item} />
      {keepable && <KeepMenuItem item={item} />}
      <DropdownMenuItem onSelect={onClose}>
        <X />
        {m.navigation_close()}
      </DropdownMenuItem>
    </>
  );
}

function NowMenu({
  canCloseAll,
  onCloseAll,
  sessionTerminals: { count, agentsBusy, closeAll: closeSessions },
}: {
  canCloseAll: boolean;
  onCloseAll: () => void;
  sessionTerminals: SessionTerminals;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarGroupAction
            type="button"
            className="top-2.5 opacity-0 group-hover/navigation-group:opacity-100 group-focus-within/navigation-group:opacity-100 data-[state=open]:opacity-100"
            aria-label={m.navigation_now_actions()}
          >
            <Ellipsis />
          </SidebarGroupAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right" className="min-w-44">
          <DropdownMenuItem disabled={!canCloseAll} onSelect={onCloseAll}>
            <X />
            {m.navigation_close_all()}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={count === 0}
            onSelect={() => {
              if (agentsBusy) {
                setConfirmOpen(true);
              } else {
                void closeSessions();
              }
            }}
          >
            <SquareX />
            {m.sessions_close_all({ count })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CloseSessionTerminalsDialog
        open={confirmOpen}
        count={count}
        onOpenChange={setConfirmOpen}
        onConfirm={() => void closeSessions()}
      />
    </>
  );
}
