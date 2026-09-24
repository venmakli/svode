import type { ShortcutGroup } from "@/shared/lib/shortcut-description";
import { useState } from "react";
import * as m from "@/paraglide/messages.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { SidebarProvider } from "@/components/ui/sidebar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useSpace } from "@/features/space";
import type { SettingsDestination } from "../model/settings-destination";
import { useSettingsNavigation } from "../hooks/use-settings-navigation";
import { AppSettingsContent } from "./app-settings-content";
import { APP_SETTINGS_NAV_ITEMS } from "./app-settings-navigation";
import { ProjectSettingsContent } from "./project-settings-content";
import { getProjectSettingsNavItems } from "./project-settings-navigation";
import { SettingsPage } from "./settings-layout";
import {
  SettingsNavigation,
  type SettingsNavigationGroup,
} from "./settings-navigation";

export function SettingsDialog({
  destination: request,
  enableLegacyAgentIntegration,
  shortcutGroups,
  onClose,
}: {
  destination: SettingsDestination;
  enableLegacyAgentIntegration: boolean;
  shortcutGroups: readonly ShortcutGroup[];
  onClose: () => void;
}) {
  const { activeRootPath, spaces } = useSpace();
  const { destination, navigate, close, registerLeaveGuard } =
    useSettingsNavigation(request, onClose);
  const [returnFocus] = useState(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const appItems = APP_SETTINGS_NAV_ITEMS.filter((item) =>
    item.show({ enableLegacyAgentIntegration }),
  );
  const projectItems = getProjectSettingsNavItems(
    enableLegacyAgentIntegration,
    spaces.length > 0,
  );
  const groups: SettingsNavigationGroup[] = [
    {
      label: "Svode",
      items: appItems.map((item) => ({
        label: item.label(),
        icon: item.icon,
        destination: { scope: "app", section: item.key },
      })),
    },
  ];
  if (activeRootPath)
    groups.push({
      label: m.settings_project_label(),
      items: projectItems.map((item) => ({
        label: item.label,
        icon: item.icon,
        destination: {
          scope: "project",
          spacePath: activeRootPath,
          section: item.key,
        },
      })),
    });
  const validProjectTarget =
    destination.scope === "project" &&
    activeRootPath &&
    (destination.spacePath === activeRootPath ||
      spaces.some((space) => space.path === destination.spacePath)) &&
    projectItems.some((item) => item.key === destination.section);
  const appSection =
    destination.scope === "app" &&
    appItems.some((item) => item.key === destination.section)
      ? destination.section
      : "git-identity";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="flex h-[90dvh] w-[90vw] max-w-none flex-col overflow-hidden p-0 sm:max-w-none"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target =
            returnFocus?.isConnected && returnFocus !== document.body
              ? returnFocus
              : document.querySelector<HTMLElement>(
                  "[data-settings-return-focus]",
                );
          target?.focus();
        }}
      >
        <DialogTitle className="sr-only">{m.settings_title()}</DialogTitle>
        <DialogDescription className="sr-only">
          {m.settings_title()}
        </DialogDescription>
        <SidebarProvider
          className="min-h-0 min-w-0 max-w-full flex-1 flex-col items-stretch overflow-hidden md:flex-row"
          style={{ minHeight: 0 }}
        >
          <SettingsNavigation
            groups={groups}
            destination={destination}
            onNavigate={navigate}
          />
          {destination.scope === "app" ? (
            <SettingsPage
              title={
                appItems.find((item) => item.key === appSection)?.label() ?? ""
              }
            >
              <AppSettingsContent
                shortcutGroups={shortcutGroups}
                registerLeaveGuard={registerLeaveGuard}
                section={appSection}
                enableLegacyAgentIntegration={enableLegacyAgentIntegration}
              />
            </SettingsPage>
          ) : validProjectTarget ? (
            <ProjectSettingsContent
              key={`${activeRootPath}:${destination.spacePath}`}
              spacePath={destination.spacePath}
              section={destination.section}
              enableLegacyAgentIntegration={enableLegacyAgentIntegration}
              onNavigate={navigate}
              onClose={close}
              registerLeaveGuard={registerLeaveGuard}
            />
          ) : (
            <div className="min-w-0 flex-1 p-4 pr-12">
              <Alert>
                <AlertDescription>
                  {m.settings_owner_unavailable()}
                </AlertDescription>
              </Alert>
            </div>
          )}
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  );
}
