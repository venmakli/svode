import type { AppSettingsSection } from "./app-settings-sections";

export type ProjectSettingsSection =
  | "general"
  | "spaces"
  | "git"
  | "storage"
  | "health"
  | "ai-agent"
  | "defaults"
  | "instructions";

export type SettingsDestination =
  | { scope: "app"; section: AppSettingsSection }
  | { scope: "project"; section: ProjectSettingsSection; spacePath: string };

export type SettingsLeaveGuard = () => boolean;
