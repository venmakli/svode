import {
  AgentSessionNavigationItem,
  agentSessionTargetFor,
} from "@/features/agent-sessions";
import {
  NavigationSidebarGroup,
  PinMenuItem,
  navigationKeyId,
  useNavigationState,
} from "@/features/navigation";
import { useShellStore } from "./model";
import { useOpenSessionInMainArea } from "./agent-session-peek-host";
import { useMainAreaObject } from "./main-area-object";
import {
  NavigationArtifactItem,
  useOpenNavigationArtifact,
} from "./navigation-sidebar-items";
import * as m from "@/paraglide/messages.js";

interface PinnedSidebarSectionProps {
  onActivateContent: () => void;
  onBeforeNavigation: () => Promise<boolean>;
}

/**
 * "Pinned" of the main sidebar: pinned artifacts and sessions in pin order,
 * opened in the main area. Hidden while nothing is pinned.
 */
export function PinnedSidebarSection({
  onActivateContent,
  onBeforeNavigation,
}: PinnedSidebarSectionProps) {
  const pinned = useNavigationState((state) => state.pinned);
  const mainTarget = useShellStore((state) =>
    state.mainSurface === "session" ? state.mainSessionTarget : null,
  );
  const mainObject = useMainAreaObject();
  const mainKeyId = mainObject ? navigationKeyId(mainObject.item.key) : null;
  const openArtifactItem = useOpenNavigationArtifact({
    onActivateContent,
    onBeforeNavigation,
  });
  const openSession = useOpenSessionInMainArea();

  if (pinned.length === 0) return null;

  return (
    <NavigationSidebarGroup id="pinned" label={m.navigation_pinned()}>
      {pinned.map((item) => {
        const id = navigationKeyId(item.key);
        const menu = <PinMenuItem item={item} />;
        if (item.key.kind === "session" || item.key.kind === "sessionLaunch") {
          return (
            <AgentSessionNavigationItem
              key={id}
              navigationKey={item.key}
              fallbackTitle={item.title}
              mainTarget={mainTarget}
              onOpen={(session) =>
                void openSession(agentSessionTargetFor(session), session, {
                  focus: false,
                })
              }
              menu={menu}
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
          />
        );
      })}
    </NavigationSidebarGroup>
  );
}
