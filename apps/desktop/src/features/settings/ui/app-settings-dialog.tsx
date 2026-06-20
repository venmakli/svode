import { useEffect, useState } from "react";
import { ENABLE_LEGACY_AGENT_INTEGRATION } from "@/app/config/feature-flags";
import * as m from "@/paraglide/messages.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
// AlertDialog removed — auto-save, no unsaved dialog needed
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  ExternalLink,
  Info,
  Keyboard,
  Paintbrush,
  PlugZap,
  RefreshCw,
  Terminal,
  User,
} from "lucide-react";
import { useAppSettingsAbout } from "../hooks/use-app-settings-about";
import { useAppSettingsAppearance } from "../hooks/use-app-settings-appearance";
import { useCliAgents } from "../hooks/use-cli-agents";
import { useGlobalIdentitySettings } from "../hooks/use-global-identity-settings";
import { McpIntegrationsSection } from "./mcp-section";
import type { AvailableAgent } from "../model";

const CLI_AUTH_COMMANDS: Record<string, string> = {
  claude: "claude login",
};

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
  icon: React.FC<{ className?: string }>;
  show: boolean;
}[] = [
  { key: "profile", label: () => m.settings_profile(), icon: User, show: true },
  {
    key: "appearance",
    label: () => m.settings_appearance(),
    icon: Paintbrush,
    show: true,
  },
  {
    key: "mcp-integrations",
    label: () => m.settings_mcp_integrations(),
    icon: PlugZap,
    show: true,
  },
  {
    key: "cli-agents",
    label: () => m.settings_cli_agents(),
    icon: Terminal,
    show: ENABLE_LEGACY_AGENT_INTEGRATION,
  },
  {
    key: "shortcuts",
    label: () => m.settings_shortcuts(),
    icon: Keyboard,
    show: true,
  },
  { key: "about", label: () => m.common_about(), icon: Info, show: true },
];

interface AppSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AppSettingsDialog({
  open,
  onOpenChange,
}: AppSettingsDialogProps) {
  const { theme, locale, handleThemeChange, handleLanguageChange } =
    useAppSettingsAppearance(open);
  const { version, buildCommit, releaseUrl, updates } = useAppSettingsAbout();
  const [section, setSection] = useState<Section>("profile");
  const {
    identityName,
    setIdentityName,
    identityEmail,
    setIdentityEmail,
    identityNameValid,
    identityEmailValid,
    canSaveIdentity,
    handleSaveIdentity,
  } = useGlobalIdentitySettings(open);
  const { agents, refreshing, refreshAgents } = useCliAgents({
    open,
    enabled: ENABLE_LEGACY_AGENT_INTEGRATION,
  });

  useEffect(() => {
    if (!open) return;
    const resetSection = window.setTimeout(() => {
      setSection("profile");
    }, 0);
    return () => window.clearTimeout(resetSection);
  }, [open]);

  function getCliStatus(
    agent: AvailableAgent,
  ): "authorized" | "unauthorized" | "not_found" {
    if (agent.authStatus === "not_found") return "not_found";
    if (agent.authStatus === "authorized") return "authorized";
    return "unauthorized";
  }

  const visibleNavItems = NAV_ITEMS.filter((item) => item.show);
  const currentNav =
    visibleNavItems.find((i) => i.key === section) ?? visibleNavItems[0];

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
                        onClick={(e) => e.preventDefault()}
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
                <div className="space-y-4 max-w-sm">
                  <div className="space-y-1">
                    <Label className="text-sm font-medium">
                      {m.settings_profile_git_identity_title()}
                    </Label>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="settings-identity-name">
                      {m.identity_name_label()}
                    </Label>
                    <Input
                      id="settings-identity-name"
                      value={identityName}
                      onChange={(e) => setIdentityName(e.target.value)}
                    />
                    {identityName && !identityNameValid && (
                      <p className="text-xs text-destructive">
                        {m.identity_name_empty()}
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="settings-identity-email">
                      {m.identity_email_label()}
                    </Label>
                    <Input
                      id="settings-identity-email"
                      type="email"
                      value={identityEmail}
                      onChange={(e) => setIdentityEmail(e.target.value)}
                    />
                    {identityEmail && !identityEmailValid && (
                      <p className="text-xs text-destructive">
                        {m.identity_email_invalid()}
                      </p>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {m.settings_profile_git_identity_hint()}
                  </p>
                  <div className="pt-1">
                    <Button
                      onClick={handleSaveIdentity}
                      disabled={!canSaveIdentity}
                    >
                      {m.identity_save()}
                    </Button>
                  </div>
                </div>
              )}

              {section === "appearance" && (
                <div className="space-y-4 max-w-sm">
                  <div className="space-y-2">
                    <Label>{m.settings_theme_label()}</Label>
                    <RadioGroup
                      value={theme}
                      onValueChange={handleThemeChange}
                      className="flex gap-4"
                    >
                      <label className="flex items-center gap-2 cursor-pointer">
                        <RadioGroupItem value="system" />
                        <span className="text-sm">
                          {m.common_theme_system()}
                        </span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <RadioGroupItem value="light" />
                        <span className="text-sm">
                          {m.common_theme_light()}
                        </span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <RadioGroupItem value="dark" />
                        <span className="text-sm">{m.common_theme_dark()}</span>
                      </label>
                    </RadioGroup>
                  </div>
                  <div className="space-y-2">
                    <Label>{m.settings_language_label()}</Label>
                    <Select
                      value={locale}
                      onValueChange={handleLanguageChange}
                    >
                      <SelectTrigger className="w-[200px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="en">
                          {m.settings_language_en()}
                        </SelectItem>
                        <SelectItem value="ru">
                          {m.settings_language_ru()}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              {ENABLE_LEGACY_AGENT_INTEGRATION && section === "cli-agents" && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-muted-foreground">
                      {m.settings_cli_agents_description()}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={refreshAgents}
                      disabled={refreshing}
                    >
                      <RefreshCw
                        className={`mr-2 h-3 w-3 ${refreshing ? "animate-spin" : ""}`}
                      />
                      {m.settings_cli_refresh()}
                    </Button>
                  </div>
                  <div className="space-y-3">
                    {agents.map((agent) => {
                      const status = getCliStatus(agent);
                      return (
                        <div
                          key={agent.name}
                          className="flex items-start gap-3 p-3 rounded-lg border"
                        >
                          <div
                            className={`mt-1 h-2 w-2 rounded-full shrink-0 ${
                              status === "authorized"
                                ? "bg-green-500"
                                : status === "unauthorized"
                                  ? "bg-yellow-500"
                                  : "bg-muted-foreground/30"
                            }`}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium capitalize">
                              {agent.name === "claude"
                                ? "Claude Code"
                                : agent.name === "codex"
                                  ? "Codex"
                                  : agent.name}
                            </div>
                            <div className="mt-0.5 text-xs text-muted-foreground">
                              {agent.path}
                            </div>
                            <div className="mt-1">
                              {status === "authorized" && (
                                <Badge
                                  variant="secondary"
                                  className="text-xs font-normal"
                                >
                                  <span className="text-green-600 mr-1">
                                    &#10003;
                                  </span>
                                  {m.settings_space_cli_found_auth({
                                    version: agent.version || "unknown",
                                  })}
                                </Badge>
                              )}
                              {status === "unauthorized" && (
                                <div className="space-y-1">
                                  <Badge
                                    variant="secondary"
                                    className="text-xs font-normal"
                                  >
                                    <span className="text-yellow-600 mr-1">
                                      &#9888;
                                    </span>
                                    {m.settings_space_cli_found_noauth({
                                      version: agent.version || "unknown",
                                    })}
                                  </Badge>
                                  {CLI_AUTH_COMMANDS[agent.name] && (
                                    <p className="text-xs text-muted-foreground">
                                      {m.settings_space_cli_noauth_hint({
                                        command: CLI_AUTH_COMMANDS[agent.name],
                                      })}
                                    </p>
                                  )}
                                </div>
                              )}
                              {status === "not_found" && (
                                <div className="flex items-center gap-2">
                                  <Badge
                                    variant="destructive"
                                    className="text-xs font-normal"
                                  >
                                    <span className="mr-1">&#10005;</span>
                                    {m.settings_space_cli_not_found()}
                                  </Badge>
                                  <a
                                    href={agent.docsUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                                  >
                                    {m.settings_space_cli_install()}
                                    <ExternalLink className="h-3 w-3" />
                                  </a>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {section === "mcp-integrations" && <McpIntegrationsSection />}

              {section === "shortcuts" && (
                <p className="text-sm text-muted-foreground">
                  {m.settings_shortcuts()}
                </p>
              )}

              {section === "about" && (
                <div className="flex max-w-md flex-col gap-4">
                  <div className="flex flex-col gap-1">
                    <Label>{m.settings_about_version()}</Label>
                    <p className="text-sm text-muted-foreground">
                      {version || "—"}
                    </p>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label>{m.settings_about_build_commit()}</Label>
                    <p className="text-sm text-muted-foreground">
                      {buildCommit ||
                        m.settings_about_build_commit_unavailable()}
                    </p>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label>{m.settings_about_updates()}</Label>
                    <p className="text-sm text-muted-foreground">
                      {updates.update
                        ? updateStatusText(updates.update.item.kind)
                        : updateFallbackText(updates.status)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        void updates.check({ silent: false, force: true })
                      }
                      disabled={updates.checking || !version}
                    >
                      <RefreshCw
                        className={`mr-2 h-3 w-3 ${updates.checking ? "animate-spin" : ""}`}
                      />
                      {updates.checking
                        ? m.settings_about_updates_checking()
                        : m.settings_about_updates_check()}
                    </Button>
                    {updates.update && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void updates.openUpdate(updates.update!)}
                      >
                        {m.updates_download()}
                      </Button>
                    )}
                  </div>
                  <a
                    href={releaseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex w-fit items-center gap-1 text-sm text-primary hover:underline"
                  >
                    {m.settings_about_releases_link()}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              )}
            </div>
          </main>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  );
}

function updateFallbackText(status: string): string {
  if (status === "current") return m.settings_about_updates_current();
  if (status === "error") return m.settings_about_updates_failed();
  return m.settings_about_updates_manual();
}

function updateStatusText(kind: "stage-release" | "ci-build"): string {
  if (kind === "ci-build") return m.settings_about_updates_ci_available();
  return m.settings_about_updates_release_available();
}
