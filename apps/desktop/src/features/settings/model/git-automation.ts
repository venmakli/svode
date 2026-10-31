import * as m from "@/paraglide/messages.js";
import type { GitUserPolicy } from "@/features/git";

/**
 * Presets of "Automation on this device" (Stage 11 1.E): they are not
 * stored, the combination of the four switches decides which one shows.
 */
export type GitAutomationPreset = "manual" | "automatic" | "custom";

export const GIT_POLICY_FIELDS = [
  "autoCommitContent",
  "autoCommitStructural",
  "autoCommitSystem",
  "autoSync",
] as const satisfies readonly (keyof GitUserPolicy)[];

/** The preset a combination of switches matches. */
export function gitAutomationPreset(
  policy: GitUserPolicy,
): GitAutomationPreset {
  const values = GIT_POLICY_FIELDS.map((field) => policy[field]);
  if (values.every((value) => !value)) return "manual";
  if (values.every(Boolean)) return "automatic";
  return "custom";
}

/** The switches a preset sets; "custom" keeps them as they are. */
export function gitAutomationPolicy(
  preset: GitAutomationPreset,
  current: GitUserPolicy,
): GitUserPolicy {
  if (preset === "custom") return current;
  const value = preset === "automatic";
  return {
    autoSync: value,
    autoCommitStructural: value,
    autoCommitSystem: value,
    autoCommitContent: value,
  };
}

/**
 * Content versions sync while Spaces and pointers Svode creates stay
 * uncommitted: their publication may wait for a manual commit.
 */
export function gitAutomationLeavesStructureUncommitted(
  policy: GitUserPolicy,
): boolean {
  return (
    policy.autoCommitContent && policy.autoSync && !policy.autoCommitStructural
  );
}

/**
 * The choices of the preset select. "Automatic" needs a remote to sync
 * with; its recommendation for teams is its description, not a default.
 */
export function gitAutomationPresetOptions(
  hasRemote: boolean,
): GitAutomationPresetOption[] {
  return [
    {
      value: "manual",
      label: m.settings_git_preset_manual(),
      description: m.settings_git_preset_manual_description(),
    },
    {
      value: "automatic",
      label: m.settings_git_preset_automatic(),
      description: m.settings_git_preset_automatic_description(),
      badge: m.settings_git_experimental(),
      disabled: !hasRemote,
    },
    {
      value: "custom",
      label: m.settings_git_preset_custom(),
      description: m.settings_git_preset_custom_description(),
    },
  ];
}

export interface GitAutomationPresetOption {
  value: GitAutomationPreset;
  label: string;
  description: string;
  badge?: string;
  disabled?: boolean;
}
