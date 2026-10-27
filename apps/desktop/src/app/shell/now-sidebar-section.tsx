import { useState } from "react";
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
  useSessionTerminals,
  type AgentSession,
  type AgentSessionTarget,
  type SessionTerminals,
} from "@/features/agent-sessions";
import {
  NavigationSidebarGroup,
  navigationKeyId,
  useKeepInNow,
  useNavigationState,
} from "@/features/navigation";
import { useShellStore } from "./model";
import { useOpenSessionInMainArea } from "./agent-session-peek-host";
import { isSessionKey, type NowTemporary } from "./now-model";
import { useActiveProjectNow } from "./now-rows";
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
 * "Now" of the main sidebar: active sessions, kept objects and the
 * temporary main area object in one list, in the order they came (DF-206).
 * An object pinned higher up is not repeated. Hidden while empty, unless
 * session terminals are open: its menu closes them.
 */
export function NowSidebarSection({
  onActivateContent,
  onBeforeNavigation,
}: NowSidebarSectionProps) {
  const kept = useNavigationState((state) => state.kept);
  const mainTarget = useShellStore((state) =>
    state.mainSurface === "session" ? state.mainSessionTarget : null,
  );
  const { rows, mainObject } = useActiveProjectNow();
  const mainKeyId = mainObject ? navigationKeyId(mainObject.item.key) : null;
  const temporary = rows.some((row) => row.kind === "temporary");
  const openArtifactItem = useOpenNavigationArtifact({
    onActivateContent,
    onBeforeNavigation,
  });
  const openSession = useOpenSessionInMainArea();
  const { closeItem, closeAll } = useWorkingSetActions();
  const sessionTerminals = useSessionTerminals();

  if (rows.length === 0 && sessionTerminals.count === 0) return null;

  const openSessionHere = (session: AgentSession) =>
    void openSession(agentSessionTargetFor(session), session, {
      focus: "composer",
    });

  return (
    <NavigationSidebarGroup
      id="now"
      label={m.navigation_now()}
      action={
        <NowMenu
          canCloseAll={kept.length > 0 || temporary}
          onCloseAll={() => void closeAll(temporary)}
          sessionTerminals={sessionTerminals}
        />
      }
    >
      {rows.map((row) => {
        switch (row.kind) {
          case "active": {
            const key = agentSessionNavigationKey(row.session);
            return (
              <AgentSessionNavigationItem
                key={navigationKeyId(key)}
                navigationKey={key}
                fallbackTitle={row.session.title}
                mainTarget={mainTarget}
                onOpen={openSessionHere}
                stepItem={pinnableAgentSessionItem(row.session)}
                keepable
              />
            );
          }
          case "kept": {
            const { item } = row;
            const id = navigationKeyId(item.key);
            const close = () => void closeItem(item.key);
            if (isSessionKey(item.key)) {
              return (
                <AgentSessionNavigationItem
                  key={id}
                  navigationKey={item.key}
                  fallbackTitle={item.title}
                  mainTarget={mainTarget}
                  onOpen={openSessionHere}
                  stepItem={item}
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
                onClose={close}
              />
            );
          }
          case "temporary":
            return (
              <TemporaryItem
                key={`temporary:${navigationKeyId(row.temporary.item.key)}`}
                temporary={row.temporary}
                mainTarget={mainTarget}
                onClose={() => void closeItem(row.temporary.item.key)}
              />
            );
        }
      })}
    </NavigationSidebarGroup>
  );
}

export function TemporaryItem({
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
  if (isSessionKey(item.key)) {
    return (
      <AgentSessionNavigationItem
        navigationKey={item.key}
        fallbackTitle={item.title}
        mainTarget={mainTarget}
        onOpen={() => undefined}
        stepItem={keepItem}
        keepable
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
      keepable
      onClose={onClose}
      temporary
      onKeep={onKeep}
    />
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
