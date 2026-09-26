import { ArrowUpRight, LoaderCircle } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  SettingsActions,
  SettingsGroup,
  SettingsItem,
  SettingsRow,
} from "./settings-layout";
import { SettingsSelect } from "./settings-select";

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
