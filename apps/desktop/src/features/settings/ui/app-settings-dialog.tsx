import { useEffect, useState, type ComponentType } from "react";
import * as m from "@/paraglide/messages.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Info,
  Keyboard,
  Paintbrush,
  PlugZap,
  Terminal,
  User,
} from "lucide-react";
import { useAppSettingsAbout } from "../hooks/use-app-settings-about";
import { useAppSettingsAppearance } from "../hooks/use-app-settings-appearance";
import { useCliAgents } from "../hooks/use-cli-agents";
import { useGlobalIdentitySettings } from "../hooks/use-global-identity-settings";
import {
  AppAboutSection,
  AppAppearanceSection,
  AppCliAgentsSection,
  AppProfileSection,
  AppShortcutsSection,
} from "./app-settings-sections";
import { McpIntegrationsSection } from "./mcp-section";

type Section =
  | "profile"
  | "appearance"
  | "mcp-integrations"
  | "cli-agents"
  | "shortcuts"
  | "about";

const NAV_ITEMS: {
  key: Section;
  label: () => string;
  icon: ComponentType<{ className?: string }>;
  show: (options: { enableLegacyAgentIntegration: boolean }) => boolean;
}[] = [
  {
    key: "profile",
    label: () => m.settings_profile(),
    icon: User,
    show: () => true,
  },
  {
    key: "appearance",
    label: () => m.settings_appearance(),
    icon: Paintbrush,
    show: () => true,
  },
  {
    key: "mcp-integrations",
    label: () => m.settings_mcp_integrations(),
    icon: PlugZap,
    show: () => true,
  },
  {
    key: "cli-agents",
    label: () => m.settings_cli_agents(),
    icon: Terminal,
    show: ({ enableLegacyAgentIntegration }) => enableLegacyAgentIntegration,
  },
  {
    key: "shortcuts",
    label: () => m.settings_shortcuts(),
    icon: Keyboard,
    show: () => true,
  },
  {
    key: "about",
    label: () => m.common_about(),
    icon: Info,
    show: () => true,
  },
];

interface AppSettingsDialogProps {
  open: boolean;
  enableLegacyAgentIntegration: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AppSettingsDialog({
  open,
  enableLegacyAgentIntegration,
  onOpenChange,
}: AppSettingsDialogProps) {
  const appearanceSettings = useAppSettingsAppearance(open);
  const aboutSettings = useAppSettingsAbout();
  const [section, setSection] = useState<Section>("profile");
  const identitySettings = useGlobalIdentitySettings(open);
  const cliAgents = useCliAgents({
    open,
    enabled: enableLegacyAgentIntegration,
  });

  useEffect(() => {
    if (!open) return;
    const resetSection = window.setTimeout(() => {
      setSection("profile");
    }, 0);
    return () => window.clearTimeout(resetSection);
  }, [open]);

  const visibleNavItems = NAV_ITEMS.filter((item) =>
    item.show({ enableLegacyAgentIntegration }),
  );
  const currentNav =
    visibleNavItems.find((item) => item.key === section) ?? visibleNavItems[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] overflow-hidden p-0 md:max-h-[500px] md:max-w-[700px] lg:max-w-[800px]">
        <DialogTitle className="sr-only">{m.settings_title()}</DialogTitle>
        <DialogDescription className="sr-only">
          {m.settings_title()}
        </DialogDescription>
        <SidebarProvider
          className="h-[480px] min-w-0 max-w-full items-start overflow-hidden"
          style={{ minHeight: 0 }}
        >
          <Sidebar collapsible="none" className="hidden shrink-0 md:flex">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {visibleNavItems.map((item) => (
                      <SidebarMenuItem key={item.key}>
                        <SidebarMenuButton
                          isActive={section === item.key}
                          onClick={() => setSection(item.key)}
                        >
                          <item.icon />
                          <span>{item.label()}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
          <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
            <header className="flex h-12 min-w-0 shrink-0 items-center gap-2 border-b">
              <div className="flex min-w-0 items-center gap-2 px-4">
                <Breadcrumb>
                  <BreadcrumbList>
                    <BreadcrumbItem className="hidden md:block">
                      <BreadcrumbLink
                        href="#"
                        onClick={(event) => event.preventDefault()}
                      >
                        {m.settings_title()}
                      </BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator className="hidden md:block" />
                    <BreadcrumbItem>
                      <BreadcrumbPage>{currentNav.label()}</BreadcrumbPage>
                    </BreadcrumbItem>
                  </BreadcrumbList>
                </Breadcrumb>
              </div>
            </header>
            <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto p-4">
              {section === "profile" && (
                <AppProfileSection settings={identitySettings} />
              )}
              {section === "appearance" && (
                <AppAppearanceSection settings={appearanceSettings} />
              )}
              {enableLegacyAgentIntegration && section === "cli-agents" && (
                <AppCliAgentsSection
                  agents={cliAgents.agents}
                  refreshing={cliAgents.refreshing}
                  onRefresh={cliAgents.refreshAgents}
                />
              )}
              {section === "mcp-integrations" && <McpIntegrationsSection />}
              {section === "shortcuts" && <AppShortcutsSection />}
              {section === "about" && <AppAboutSection {...aboutSettings} />}
            </div>
          </main>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  );
}
