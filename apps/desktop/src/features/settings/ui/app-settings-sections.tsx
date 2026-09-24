import {
  ArrowUpRight,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import * as m from "@/paraglide/messages.js";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DogfoodUpdateSettingsControls,
  DogfoodUpdateSettingsStatus,
} from "@/features/updates";
import { cn } from "@/shared/lib/utils";
import type { useAppSettingsAbout } from "../hooks/use-app-settings-about";
import type { useAppSettingsAppearance } from "../hooks/use-app-settings-appearance";
import type { useGlobalIdentitySettings } from "../hooks/use-global-identity-settings";
import type { AvailableAgent } from "../model";
import {
  SettingsActions,
  SettingsGroup,
  SettingsItem,
  SettingsRow,
} from "./settings-layout";
import { SettingsSelect } from "./settings-select";

const CLI_AUTH_COMMANDS: Record<string, string> = {
  claude: "claude login",
};

type AppSettingsAbout = ReturnType<typeof useAppSettingsAbout>;
type AppSettingsAppearance = ReturnType<typeof useAppSettingsAppearance>;
type GlobalIdentitySettings = ReturnType<typeof useGlobalIdentitySettings>;

interface AppGitIdentitySectionProps {
  settings: GlobalIdentitySettings;
}

export function AppGitIdentitySection({
  settings,
}: AppGitIdentitySectionProps) {
  const nameInvalid = Boolean(
    settings.identityName && !settings.identityNameValid,
  );
  const emailInvalid = Boolean(
    settings.identityEmail && !settings.identityEmailValid,
  );
  return (
    <SettingsGroup
      title={m.settings_profile_git_identity_title()}
      description={m.settings_git_identity_scope()}
      callout={
        settings.identityStale ? (
          <Alert>
            <AlertTitle>{m.settings_git_identity_stale_title()}</AlertTitle>
            <AlertDescription>
              <p>{m.settings_git_identity_stale_description()}</p>
              <div className="flex flex-wrap gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={settings.savingIdentity}
                  onClick={settings.handleUseLatestIdentity}
                >
                  {m.settings_git_identity_use_latest()}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={settings.savingIdentity}
                  onClick={settings.handleKeepIdentityDraft}
                >
                  {m.settings_git_identity_keep_draft()}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : null
      }
    >
      <SettingsRow
        label={m.identity_name_label()}
        htmlFor="settings-identity-name"
        error={nameInvalid ? m.identity_name_empty() : null}
      >
        <Input
          id="settings-identity-name"
          className="w-64 max-w-full"
          value={settings.identityName}
          disabled={settings.savingIdentity}
          aria-invalid={nameInvalid}
          onChange={(event) => settings.setIdentityName(event.target.value)}
        />
      </SettingsRow>
      <SettingsRow
        label={m.identity_email_label()}
        htmlFor="settings-identity-email"
        error={emailInvalid ? m.identity_email_invalid() : null}
      >
        <Input
          id="settings-identity-email"
          type="email"
          className="w-64 max-w-full"
          value={settings.identityEmail}
          disabled={settings.savingIdentity}
          aria-invalid={emailInvalid}
          onChange={(event) => settings.setIdentityEmail(event.target.value)}
        />
      </SettingsRow>
      <SettingsActions>
        <Button
          type="button"
          onClick={settings.handleSaveIdentity}
          disabled={!settings.canSaveIdentity}
        >
          {settings.savingIdentity ? (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          ) : null}
          {m.identity_save()}
        </Button>
      </SettingsActions>
    </SettingsGroup>
  );
}

interface AppAppearanceSectionProps {
  settings: AppSettingsAppearance;
}

export function AppAppearanceSection({ settings }: AppAppearanceSectionProps) {
  return (
    <SettingsGroup description={m.settings_appearance_device_scope()}>
      <SettingsRow
        label={m.settings_theme_label()}
        htmlFor="app-settings-theme"
      >
        <SettingsSelect
          id="app-settings-theme"
          value={settings.theme}
          pending={settings.themePending}
          onValueChange={settings.handleThemeChange}
          options={[
            {
              value: "system",
              label: m.common_theme_system(),
              description: m.settings_theme_system_description(),
            },
            { value: "light", label: m.common_theme_light() },
            { value: "dark", label: m.common_theme_dark() },
          ]}
        />
      </SettingsRow>
      <SettingsRow
        label={m.settings_language_label()}
        htmlFor="app-settings-language"
      >
        <SettingsSelect
          id="app-settings-language"
          value={settings.locale}
          pending={settings.localePending}
          onValueChange={settings.handleLanguageChange}
          options={[
            { value: "en", label: m.settings_language_en() },
            { value: "ru", label: m.settings_language_ru() },
          ]}
        />
      </SettingsRow>
    </SettingsGroup>
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

export function AppAboutSection({
  version,
  buildCommit,
  releaseUrl,
}: AppSettingsAbout) {
  return (
    <SettingsGroup>
      <SettingsItem
        title={m.settings_about_version()}
        actions={
          <span className="text-sm text-muted-foreground">
            {version || "—"}
          </span>
        }
      />
      <SettingsItem
        title={m.settings_about_build_commit()}
        actions={
          <span
            className={cn(
              "text-sm text-muted-foreground break-all",
              buildCommit && "font-mono",
            )}
          >
            {buildCommit || m.settings_about_build_commit_unavailable()}
          </span>
        }
      />
      <SettingsItem
        title={m.updates_status_label()}
        description={<DogfoodUpdateSettingsStatus />}
        actions={<DogfoodUpdateSettingsControls />}
      />
      <SettingsItem
        title={m.settings_about_releases()}
        actions={
          <Button asChild variant="link" size="sm">
            <a href={releaseUrl} target="_blank" rel="noopener noreferrer">
              {m.settings_about_releases_link()}
              <ArrowUpRight data-icon="inline-end" />
            </a>
          </Button>
        }
      />
    </SettingsGroup>
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
