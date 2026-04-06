import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { setLocale, getLocale } from "@/paraglide/runtime.js";
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
import { useTheme } from "@/components/ui/theme-provider";
import { ExternalLink, Keyboard, Paintbrush, RefreshCw, Terminal, User } from "lucide-react";
import { invalidateAppSettings } from "@/hooks/use-app-settings";
import type { AppSettings, AvailableAgent } from "@/types/workspace";

const AVATAR_COLORS = [
  "#3B82F6", "#EF4444", "#10B981", "#F59E0B", "#8B5CF6",
  "#EC4899", "#06B6D4", "#F97316", "#6366F1", "#14B8A6",
];

const CLI_AUTH_COMMANDS: Record<string, string> = {
  claude: "claude login",
};

type Section = "profile" | "appearance" | "cli-agents" | "shortcuts";

const NAV_ITEMS: { key: Section; label: () => string; icon: React.FC<{ className?: string }> }[] = [
  { key: "profile", label: () => m.settings_profile(), icon: User },
  { key: "appearance", label: () => m.settings_appearance(), icon: Paintbrush },
  { key: "cli-agents", label: () => m.settings_cli_agents(), icon: Terminal },
  { key: "shortcuts", label: () => m.settings_shortcuts(), icon: Keyboard },
];

interface AppSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AppSettingsDialog({ open, onOpenChange }: AppSettingsDialogProps) {
  const { theme, setTheme } = useTheme();
  const [section, setSection] = useState<Section>("profile");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState("#3B82F6");
  const [savedName, setSavedName] = useState("");

  const [agents, setAgents] = useState<AvailableAgent[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const loadSettings = useCallback(async () => {
    try {
      const s = await invoke<AppSettings>("get_app_settings");
      setSettings(s);
      setName(s.user.name);
      setAvatar(s.user.avatar);
      setSavedName(s.user.name);
    } catch (err) {
      console.error("Failed to load settings:", err);
    }
  }, []);

  const loadAgents = useCallback(async () => {
    try {
      const list = await invoke<AvailableAgent[]>("agent_list_available");
      setAgents(list);
    } catch (err) {
      console.error("Failed to load agents:", err);
    }
  }, []);

  useEffect(() => {
    if (open) {
      loadSettings();
      loadAgents();
      setSection("profile");
    }
  }, [open, loadSettings, loadAgents]);

  async function saveSettings(updated: Partial<AppSettings>) {
    if (!settings) return;
    const merged: AppSettings = {
      ...settings,
      user: { ...settings.user, ...updated.user },
      appearance: { ...settings.appearance, ...updated.appearance },
      window: { ...settings.window, ...updated.window },
    };
    try {
      await invoke("save_app_settings", { settingsData: merged });
      setSettings(merged);
      invalidateAppSettings();
      return true;
    } catch (err) {
      console.error("Failed to save settings:", err);
      toast.error(m.toast_error());
      return false;
    }
  }

  async function handleNameBlur() {
    const trimmed = name.trim();
    if (trimmed && trimmed !== savedName) {
      const ok = await saveSettings({ user: { name: trimmed, avatar } });
      if (ok) {
        setSavedName(trimmed);
        setName(trimmed);
      }
    }
  }

  async function handleThemeChange(value: string) {
    setTheme(value as "light" | "dark" | "system");
    await saveSettings({ appearance: { theme: value, language: settings?.appearance.language ?? "en" } });
  }

  async function handleLanguageChange(value: string) {
    setLocale(value as "en" | "ru");
    await saveSettings({ appearance: { theme: settings?.appearance.theme ?? "system", language: value } });
  }

  async function handleAvatarChange(color: string) {
    setAvatar(color);
    await saveSettings({ user: { name, avatar: color } });
  }

  async function handleRefreshAgents() {
    setRefreshing(true);
    await loadAgents();
    setRefreshing(false);
  }

  function getCliStatus(agent: AvailableAgent): "authorized" | "unauthorized" | "not_found" {
    if (agent.authStatus === "not_found") return "not_found";
    if (agent.authStatus === "authorized") return "authorized";
    return "unauthorized";
  }

  const currentNav = NAV_ITEMS.find((i) => i.key === section)!;

  return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="overflow-hidden p-0 md:max-h-[500px] md:max-w-[700px] lg:max-w-[800px]">
          <DialogTitle className="sr-only">{m.settings_title()}</DialogTitle>
          <DialogDescription className="sr-only">{m.settings_title()}</DialogDescription>
          <SidebarProvider className="items-start">
            <Sidebar collapsible="none" className="hidden md:flex">
              <SidebarContent>
                <SidebarGroup>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {NAV_ITEMS.map((item) => (
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
            <main className="flex h-[480px] flex-1 flex-col overflow-hidden">
              <header className="flex h-12 shrink-0 items-center gap-2 border-b">
                <div className="flex items-center gap-2 px-4">
                  <Breadcrumb>
                    <BreadcrumbList>
                      <BreadcrumbItem className="hidden md:block">
                        <BreadcrumbLink href="#" onClick={(e) => e.preventDefault()}>
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
              <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
                {section === "profile" && (
                  <div className="space-y-4 max-w-sm">
                    <div className="space-y-2">
                      <Label htmlFor="settings-name">{m.settings_profile_name()}</Label>
                      <Input
                        id="settings-name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        onBlur={handleNameBlur}
                        placeholder={m.settings_profile_name_placeholder()}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>{m.settings_profile_avatar()}</Label>
                      <div className="flex gap-2 flex-wrap">
                        {AVATAR_COLORS.map((color) => (
                          <button
                            key={color}
                            type="button"
                            className={`w-8 h-8 rounded-md transition-all ${
                              avatar === color ? "ring-2 ring-offset-2 ring-primary" : ""
                            }`}
                            style={{ backgroundColor: color }}
                            onClick={() => handleAvatarChange(color)}
                          />
                        ))}
                      </div>
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
                          <span className="text-sm">{m.common_theme_system()}</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <RadioGroupItem value="light" />
                          <span className="text-sm">{m.common_theme_light()}</span>
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
                        value={getLocale()}
                        onValueChange={handleLanguageChange}
                      >
                        <SelectTrigger className="w-[200px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="en">{m.settings_language_en()}</SelectItem>
                          <SelectItem value="ru">{m.settings_language_ru()}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}

                {section === "cli-agents" && (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-muted-foreground">
                        {m.settings_cli_agents_description()}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleRefreshAgents}
                        disabled={refreshing}
                      >
                        <RefreshCw className={`mr-2 h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
                        {m.settings_cli_refresh()}
                      </Button>
                    </div>
                    <div className="space-y-3">
                      {agents.map((agent) => {
                        const status = getCliStatus(agent);
                        return (
                          <div key={agent.name} className="flex items-start gap-3 p-3 rounded-lg border">
                            <div className={`mt-1 h-2 w-2 rounded-full shrink-0 ${
                              status === "authorized" ? "bg-green-500" :
                              status === "unauthorized" ? "bg-yellow-500" : "bg-muted-foreground/30"
                            }`} />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium capitalize">
                                {agent.name === "claude" ? "Claude Code" : agent.name === "codex" ? "Codex" : agent.name}
                              </div>
                              <div className="mt-0.5 text-xs text-muted-foreground">{agent.path}</div>
                              <div className="mt-1">
                                {status === "authorized" && (
                                  <Badge variant="secondary" className="text-xs font-normal">
                                    <span className="text-green-600 mr-1">&#10003;</span>
                                    {m.settings_workspace_cli_found_auth({ version: agent.version || "unknown" })}
                                  </Badge>
                                )}
                                {status === "unauthorized" && (
                                  <div className="space-y-1">
                                    <Badge variant="secondary" className="text-xs font-normal">
                                      <span className="text-yellow-600 mr-1">&#9888;</span>
                                      {m.settings_workspace_cli_found_noauth({ version: agent.version || "unknown" })}
                                    </Badge>
                                    {CLI_AUTH_COMMANDS[agent.name] && (
                                      <p className="text-xs text-muted-foreground">
                                        {m.settings_workspace_cli_noauth_hint({ command: CLI_AUTH_COMMANDS[agent.name] })}
                                      </p>
                                    )}
                                  </div>
                                )}
                                {status === "not_found" && (
                                  <div className="flex items-center gap-2">
                                    <Badge variant="destructive" className="text-xs font-normal">
                                      <span className="mr-1">&#10005;</span>
                                      {m.settings_workspace_cli_not_found()}
                                    </Badge>
                                    <a
                                      href={agent.docsUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                                    >
                                      {m.settings_workspace_cli_install()}
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

                {section === "shortcuts" && (
                  <p className="text-sm text-muted-foreground">
                    {m.settings_shortcuts()}
                  </p>
                )}
              </div>
            </main>
          </SidebarProvider>
        </DialogContent>
      </Dialog>
  );
}
