import { ListX } from "lucide-react";
import { SidebarGroupAction } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AgentSessionNavigationItem,
  agentSessionNavigationKey,
  agentSessionTargetFor,
  pinnableAgentSessionItem,
  type AgentSession,
  type AgentSessionTarget,
} from "@/features/agent-sessions";
import {
  NavigationSidebarGroup,
  navigationKeyId,
  useKeepInNow,
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
 * An object pinned higher up is not repeated. Every row closes, and "Close
 * all" of the header closes them all, stopping nothing (DF-207). Hidden
 * while empty.
 */
export function NowSidebarSection({
  onActivateContent,
  onBeforeNavigation,
}: NowSidebarSectionProps) {
  const mainTarget = useShellStore((state) =>
    state.mainSurface === "session" ? state.mainSessionTarget : null,
  );
  const { rows, mainObject } = useActiveProjectNow();
  const mainKeyId = mainObject ? navigationKeyId(mainObject.item.key) : null;
  const openArtifactItem = useOpenNavigationArtifact({
    onActivateContent,
    onBeforeNavigation,
  });
  const openSession = useOpenSessionInMainArea();
  const { closeItem, closeActiveSession, closeAll } = useWorkingSetActions();

  if (rows.length === 0) return null;

  const openSessionHere = (session: AgentSession) =>
    void openSession(agentSessionTargetFor(session), session, {
      focus: "composer",
    });

  return (
    <NavigationSidebarGroup
      id="now"
      label={m.navigation_now()}
      action={<CloseAllAction onCloseAll={() => void closeAll(rows)} />}
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
                onClose={() => void closeActiveSession(row)}
                closeKeepsWorking
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

/** "Close all" of the Now header: it shows on hover and focus of the group. */
function CloseAllAction({ onCloseAll }: { onCloseAll: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <SidebarGroupAction
          type="button"
          className="top-2.5 opacity-0 group-hover/navigation-group:opacity-100 group-focus-within/navigation-group:opacity-100"
          aria-label={m.navigation_close_all_now()}
          onClick={onCloseAll}
        >
          <ListX />
        </SidebarGroupAction>
      </TooltipTrigger>
      <TooltipContent side="right">{m.navigation_close_all()}</TooltipContent>
    </Tooltip>
  );
}
