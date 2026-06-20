import { ExternalLink, RefreshCw } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/shared/lib/utils";
import type { useAppSettingsAbout } from "../hooks/use-app-settings-about";
import type { useAppSettingsAppearance } from "../hooks/use-app-settings-appearance";
import type { useGlobalIdentitySettings } from "../hooks/use-global-identity-settings";
import type { AvailableAgent } from "../model";

const CLI_AUTH_COMMANDS: Record<string, string> = {
  claude: "claude login",
};

type AppSettingsAbout = ReturnType<typeof useAppSettingsAbout>;
type AppSettingsAppearance = ReturnType<typeof useAppSettingsAppearance>;
type GlobalIdentitySettings = ReturnType<typeof useGlobalIdentitySettings>;

interface AppProfileSectionProps {
  settings: GlobalIdentitySettings;
}

export function AppProfileSection({ settings }: AppProfileSectionProps) {
  return (
    <div className="flex max-w-sm flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Label className="text-sm font-medium">
          {m.settings_profile_git_identity_title()}
        </Label>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="settings-identity-name">
          {m.identity_name_label()}
        </Label>
        <Input
          id="settings-identity-name"
          value={settings.identityName}
          onChange={(event) => settings.setIdentityName(event.target.value)}
        />
        {settings.identityName && !settings.identityNameValid && (
          <p className="text-xs text-destructive">{m.identity_name_empty()}</p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="settings-identity-email">
          {m.identity_email_label()}
        </Label>
        <Input
          id="settings-identity-email"
          type="email"
          value={settings.identityEmail}
          onChange={(event) => settings.setIdentityEmail(event.target.value)}
        />
        {settings.identityEmail && !settings.identityEmailValid && (
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
          onClick={settings.handleSaveIdentity}
          disabled={!settings.canSaveIdentity}
        >
          {m.identity_save()}
        </Button>
      </div>
    </div>
  );
}

interface AppAppearanceSectionProps {
  settings: AppSettingsAppearance;
}

export function AppAppearanceSection({ settings }: AppAppearanceSectionProps) {
  return (
    <div className="flex max-w-sm flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label>{m.settings_theme_label()}</Label>
        <RadioGroup
          value={settings.theme}
          onValueChange={settings.handleThemeChange}
          className="flex gap-4"
        >
          <label className="flex cursor-pointer items-center gap-2">
            <RadioGroupItem value="system" />
            <span className="text-sm">{m.common_theme_system()}</span>
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <RadioGroupItem value="light" />
            <span className="text-sm">{m.common_theme_light()}</span>
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <RadioGroupItem value="dark" />
            <span className="text-sm">{m.common_theme_dark()}</span>
          </label>
        </RadioGroup>
      </div>
      <div className="flex flex-col gap-2">
        <Label>{m.settings_language_label()}</Label>
        <Select
          value={settings.locale}
          onValueChange={settings.handleLanguageChange}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="en">{m.settings_language_en()}</SelectItem>
              <SelectItem value="ru">{m.settings_language_ru()}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

interface AppCliAgentsSectionProps {
  agents: AvailableAgent[];
  refreshing: boolean;
  onRefresh: () => void;
}

export function AppCliAgentsSection({
  agents,
  refreshing,
  onRefresh,
}: AppCliAgentsSectionProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {m.settings_cli_agents_description()}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCw
            data-icon="inline-start"
            className={refreshing ? "animate-spin" : undefined}
          />
          {m.settings_cli_refresh()}
        </Button>
      </div>
      <div className="flex flex-col gap-3">
        {agents.map((agent) => (
          <CliAgentStatusRow key={agent.name} agent={agent} />
        ))}
      </div>
    </div>
  );
}

export function AppShortcutsSection() {
  return (
    <p className="text-sm text-muted-foreground">{m.settings_shortcuts()}</p>
  );
}

export function AppAboutSection({
  version,
  buildCommit,
  releaseUrl,
  updates,
}: AppSettingsAbout) {
  return (
    <div className="flex max-w-md flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Label>{m.settings_about_version()}</Label>
        <p className="text-sm text-muted-foreground">{version || "—"}</p>
      </div>
      <div className="flex flex-col gap-1">
        <Label>{m.settings_about_build_commit()}</Label>
        <p className="text-sm text-muted-foreground">
          {buildCommit || m.settings_about_build_commit_unavailable()}
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
          onClick={() => void updates.check({ silent: false, force: true })}
          disabled={updates.checking || !version}
        >
          <RefreshCw
            data-icon="inline-start"
            className={updates.checking ? "animate-spin" : undefined}
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
        <ExternalLink className="size-3" />
      </a>
    </div>
  );
}

function CliAgentStatusRow({ agent }: { agent: AvailableAgent }) {
  const status = getCliStatus(agent);
  return (
    <div className="flex items-start gap-3 rounded-lg border p-3">
      <div
        className={cn(
          "mt-1 size-2 shrink-0 rounded-full",
          status === "authorized"
            ? "bg-green-500"
            : status === "unauthorized"
              ? "bg-yellow-500"
              : "bg-muted-foreground/30",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium capitalize">
          {agent.name === "claude"
            ? "Claude Code"
            : agent.name === "codex"
              ? "Codex"
              : agent.name}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">{agent.path}</div>
        <div className="mt-1">
          {status === "authorized" && (
            <Badge variant="secondary" className="text-xs font-normal">
              <span className="mr-1 text-green-600">&#10003;</span>
              {m.settings_space_cli_found_auth({
                version: agent.version || "unknown",
              })}
            </Badge>
          )}
          {status === "unauthorized" && (
            <div className="flex flex-col gap-1">
              <Badge variant="secondary" className="text-xs font-normal">
                <span className="mr-1 text-yellow-600">&#9888;</span>
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
              <Badge variant="destructive" className="text-xs font-normal">
                <span className="mr-1">&#10005;</span>
                {m.settings_space_cli_not_found()}
              </Badge>
              <a
                href={agent.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                {m.settings_space_cli_install()}
                <ExternalLink className="size-3" />
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function getCliStatus(
  agent: AvailableAgent,
): "authorized" | "unauthorized" | "not_found" {
  if (agent.authStatus === "not_found") return "not_found";
  if (agent.authStatus === "authorized") return "authorized";
  return "unauthorized";
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
