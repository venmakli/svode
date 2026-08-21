import { ExternalLink, RefreshCw } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { DogfoodUpdateSettingsControls } from "@/features/updates";
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

interface AppGitIdentitySectionProps {
  settings: GlobalIdentitySettings;
}

export function AppGitIdentitySection({
  settings,
}: AppGitIdentitySectionProps) {
  return (
    <div className="flex max-w-sm flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">
          {m.settings_profile_git_identity_title()}
        </h2>
        <p className="text-sm text-muted-foreground">
          {m.settings_git_identity_scope()}
        </p>
      </div>
      <FieldGroup>
        <Field
          data-invalid={Boolean(
            settings.identityName && !settings.identityNameValid,
          )}
        >
          <FieldLabel htmlFor="settings-identity-name">
            {m.identity_name_label()}
          </FieldLabel>
          <Input
            id="settings-identity-name"
            value={settings.identityName}
            disabled={settings.savingIdentity}
            aria-invalid={Boolean(
              settings.identityName && !settings.identityNameValid,
            )}
            onChange={(event) => settings.setIdentityName(event.target.value)}
          />
          {settings.identityName && !settings.identityNameValid && (
            <FieldError>{m.identity_name_empty()}</FieldError>
          )}
        </Field>
        <Field
          data-invalid={Boolean(
            settings.identityEmail && !settings.identityEmailValid,
          )}
        >
          <FieldLabel htmlFor="settings-identity-email">
            {m.identity_email_label()}
          </FieldLabel>
          <Input
            id="settings-identity-email"
            type="email"
            value={settings.identityEmail}
            disabled={settings.savingIdentity}
            aria-invalid={Boolean(
              settings.identityEmail && !settings.identityEmailValid,
            )}
            onChange={(event) => settings.setIdentityEmail(event.target.value)}
          />
          {settings.identityEmail && !settings.identityEmailValid && (
            <FieldError>{m.identity_email_invalid()}</FieldError>
          )}
        </Field>
      </FieldGroup>
      {settings.identityStale && (
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
      )}
      <div className="pt-1">
        <Button
          type="button"
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
      <p className="text-sm text-muted-foreground">
        {m.settings_appearance_device_scope()}
      </p>
      <div className="flex flex-col gap-2">
        <Label id="app-settings-theme-label">
          {m.settings_theme_label()}
        </Label>
        <RadioGroup
          value={settings.theme}
          onValueChange={settings.handleThemeChange}
          disabled={settings.themePending}
          aria-labelledby="app-settings-theme-label"
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
        <Label htmlFor="app-settings-language">
          {m.settings_language_label()}
        </Label>
        <Select
          value={settings.locale}
          onValueChange={settings.handleLanguageChange}
          disabled={settings.localePending}
        >
          <SelectTrigger id="app-settings-language" className="w-[200px]">
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
      <DogfoodUpdateSettingsControls
        version={version}
        buildCommit={buildCommit}
      />
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
