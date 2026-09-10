import { useState } from "react";
import * as m from "@/paraglide/messages.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { SidebarProvider } from "@/components/ui/sidebar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useSpace } from "@/features/space";
import type { SettingsDestination } from "../model/settings-destination";
import { useSettingsNavigation } from "../hooks/use-settings-navigation";
import { AppSettingsContent } from "./app-settings-content";
import { APP_SETTINGS_NAV_ITEMS } from "./app-settings-navigation";
import { ProjectSettingsContent } from "./project-settings-content";
import { getProjectSettingsNavItems } from "./project-settings-navigation";
import {
  SettingsNavigation,
  type SettingsNavigationGroup,
} from "./settings-navigation";

export function SettingsDialog({
  destination: request,
  enableLegacyAgentIntegration,
  onClose,
}: {
  destination: SettingsDestination;
  enableLegacyAgentIntegration: boolean;
  onClose: () => void;
}) {
  const { activeRootPath, activeRootName, spaces } = useSpace();
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
      label: m.settings_project_group({ name: activeRootName || "Project" }),
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
        className="w-[calc(100vw-2rem)] max-h-[calc(100dvh-2rem)] overflow-hidden p-0 md:max-w-[700px] lg:max-w-[800px]"
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
          className="h-[480px] max-h-[calc(100dvh-2rem)] min-w-0 max-w-full flex-col items-stretch overflow-hidden md:flex-row"
          style={{ minHeight: 0 }}
        >
          <SettingsNavigation
            groups={groups}
            destination={destination}
            onNavigate={navigate}
          />
          {destination.scope === "app" ? (
            <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              <header className="flex min-h-12 shrink-0 items-center border-b px-4 py-2 pr-12">
                <Breadcrumb className="min-w-0">
                  <BreadcrumbList className="flex-nowrap">
                    <BreadcrumbItem>Svode</BreadcrumbItem>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem className="min-w-0">
                      <BreadcrumbPage className="truncate">
                        {appItems
                          .find((item) => item.key === appSection)
                          ?.label()}
                      </BreadcrumbPage>
                    </BreadcrumbItem>
                  </BreadcrumbList>
                </Breadcrumb>
              </header>
              <AppSettingsContent
                section={appSection}
                enableLegacyAgentIntegration={enableLegacyAgentIntegration}
              />
            </main>
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
