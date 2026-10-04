import type {
  AgentSessionSettingDto,
  AgentSessionUsageDto,
  AgentSettingValueDto,
} from "@/platform/agent-runtime/agent-runtime-api";

export type SessionSetting = AgentSessionSettingDto;
export type SettingValue = AgentSettingValueDto;

/**
 * The session settings the agent declared (`02` C5), in the places the
 * composer shows them (`04` composer): the model and reasoning in the
 * agent button, the permission mode under the field, every other setting
 * as a block of the agent button in the agent's order.
 */
export interface SessionControls {
  model: SessionSetting | null;
  reasoning: SessionSetting | null;
  mode: SessionSetting | null;
  others: SessionSetting[];
}

export function sessionControls(settings: SessionSetting[]): SessionControls {
  const first = (category: SessionSetting["category"]) =>
    settings.find((setting) => setting.category === category) ?? null;
  const model = first("model");
  const reasoning = first("thought_level");
  const mode = first("mode");
  return {
    model,
    reasoning,
    mode,
    others: settings.filter(
      (setting) =>
        setting !== model && setting !== reasoning && setting !== mode,
    ),
  };
}

/** The agent's name of the setting's confirmed value. */
export function currentOptionName(setting: SessionSetting): string {
  return (
    setting.options.find((option) => option.value === setting.currentValue)
      ?.name ?? setting.currentValue
  );
}

/** From this many models the model block has a search. */
export const MODEL_SEARCH_FROM = 5;

/** Options whose name, value or description contains the query. */
export function filterOptions(
  options: SessionSetting["options"],
  query: string,
): SessionSetting["options"] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return options;
  return options.filter((option) =>
    [option.name, option.value, option.description ?? ""].some((text) =>
      text.toLocaleLowerCase().includes(needle),
    ),
  );
}

export type ContextLevel = "normal" | "warning" | "critical";

export interface ContextUsage {
  used: number;
  size: number;
  /** Share of the window in use, 0..1. */
  fraction: number;
  level: ContextLevel;
  cost: AgentSessionUsageDto["cost"];
}

/**
 * The context indicator from the agent's last usage report; none without
 * a report or without both `used` and `size`, and nothing is derived from
 * other data.
 */
export function contextUsage(
  usage: AgentSessionUsageDto | null,
): ContextUsage | null {
  if (!usage) return null;
  const { used, size } = usage;
  if (
    !Number.isFinite(used) ||
    !Number.isFinite(size) ||
    size <= 0 ||
    used < 0
  ) {
    return null;
  }
  const fraction = Math.min(used / size, 1);
  return {
    used,
    size,
    fraction,
    level:
      fraction >= 0.9 ? "critical" : fraction >= 0.75 ? "warning" : "normal",
    cost: usage.cost,
  };
}

/**
 * Values a draft keeps for a draft session the agent created anew, as
 * after a window reload: `apply` are declared values the session does not
 * have yet, `undeclared` are values it does not offer and that are not
 * replaced silently.
 */
export function draftValuesToApply(
  values: SettingValue[],
  settings: SessionSetting[],
): { apply: SettingValue[]; undeclared: SettingValue[] } {
  const apply: SettingValue[] = [];
  const undeclared: SettingValue[] = [];
  for (const value of values) {
    const setting = settings.find((known) => known.id === value.setting);
    if (!setting?.options.some((option) => option.value === value.value)) {
      undeclared.push(value);
    } else if (setting.currentValue !== value.value) {
      apply.push(value);
    }
  }
  return { apply, undeclared };
}

/** The draft's values with `value` in place of the setting's earlier one. */
export function withDraftValue(
  values: SettingValue[],
  value: SettingValue,
): SettingValue[] {
  return [...values.filter((known) => known.setting !== value.setting), value];
}
