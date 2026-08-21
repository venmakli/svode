export type AppSettingsSection =
  | "git-identity"
  | "appearance"
  | "mcp-integrations"
  | "cli-agents"
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
  "mcp-integrations": "owner-integration",
  "cli-agents": "command-derived",
  shortcuts: "read-only",
  about: "command-derived",
} as const satisfies Record<AppSettingsSection, AppSettingsSectionKind>;
