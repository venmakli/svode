export type AppSettingsSection =
  | "git-identity"
  | "appearance"
  | "variables"
  | "providers"
  | "sessions"
  | "shortcuts"
  | "about";

export type AppSettingsSectionKind =
  | "app-preference"
  | "owner-setting"
  | "owner-integration"
  | "command-derived"
  | "read-only";

export const APP_SETTINGS_SECTION_KINDS = {
  "git-identity": "owner-setting",
  appearance: "app-preference",
  variables: "owner-setting",
  providers: "owner-integration",
  sessions: "owner-setting",
  shortcuts: "read-only",
  about: "command-derived",
} as const satisfies Record<AppSettingsSection, AppSettingsSectionKind>;
