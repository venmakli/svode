import type { AgentDeclarationDto } from "@/platform/agent-runtime/agent-runtime-api";
import type { SessionSetting, SettingValue } from "./session-controls";

export type AgentDeclaration = AgentDeclarationDto;

/**
 * What a draft shows of its agent's settings before a session starts
 * (Stage 11 `03`, announcements without a started session).
 */
export interface DeclaredSettings {
  /** The settings with the draft's values; null while none are known. */
  settings: SessionSetting[] | null;
  /** They come from the agent's last session on this device. */
  recorded: boolean;
  /**
   * Settings whose options for the chosen model are not known yet: they
   * keep the agent's default until a session with that model declares them.
   */
  withoutVariants: string[];
}

/** Settings of these categories do not change with the model. */
const MODEL_INDEPENDENT: SessionSetting["category"][] = ["model", "mode"];

/**
 * The settings a draft that keeps its own values shows: those of a draft
 * session that takes values only with the first send, otherwise the agent's
 * last declarations for the chosen model, else its latest ones. Options of
 * the settings that follow the model come from the last declarations for
 * the chosen model; without them such a setting shows no options and keeps
 * the agent's default. The draft's values show where the setting declares
 * them.
 */
export function declaredSettings({
  session,
  declarations,
  values,
}: {
  /** What a draft session declared; null without one. */
  session: SessionSetting[] | null;
  /** The agent's last declarations, the latest first. */
  declarations: AgentDeclaration[];
  values: SettingValue[];
}): DeclaredSettings {
  const chosenModel = (settings: SessionSetting[]) => {
    const model = settings.find((setting) => setting.category === "model");
    return model
      ? (values.find((value) => value.setting === model.id)?.value ?? null)
      : null;
  };
  let base: SessionSetting[];
  let recorded = false;
  if (session) {
    base = session;
  } else if (declarations.length > 0) {
    const latest = declarations[0].settings;
    const chosen = chosenModel(latest);
    base =
      declarations.find((declaration) => declaration.model === chosen)
        ?.settings ?? latest;
    recorded = true;
  } else {
    return { settings: null, recorded: false, withoutVariants: [] };
  }
  const model = base.find((setting) => setting.category === "model");
  const chosen = chosenModel(base);
  const withoutVariants: string[] = [];
  let settings = base;
  if (
    model &&
    chosen !== null &&
    chosen !== model.currentValue &&
    model.options.some((option) => option.value === chosen)
  ) {
    const forModel = declarations.find(
      (declaration) => declaration.model === chosen,
    );
    if (forModel) {
      recorded = true;
      settings = [
        ...base.filter((setting) =>
          MODEL_INDEPENDENT.includes(setting.category),
        ),
        ...forModel.settings.filter(
          (setting) => !MODEL_INDEPENDENT.includes(setting.category),
        ),
      ];
    } else {
      settings = base.map((setting) => {
        if (MODEL_INDEPENDENT.includes(setting.category)) return setting;
        withoutVariants.push(setting.id);
        return { ...setting, currentValue: "", options: [] };
      });
    }
  }
  return {
    settings: settings.map((setting) => {
      const value = values.find((known) => known.setting === setting.id);
      return value &&
        setting.options.some((option) => option.value === value.value)
        ? { ...setting, currentValue: value.value }
        : setting;
    }),
    recorded,
    withoutVariants,
  };
}

/**
 * The draft's values with `value` chosen: choosing another model drops the
 * values of the settings that follow the model, whose options it changes.
 */
export function withKeptValue(
  values: SettingValue[],
  value: SettingValue,
  settings: SessionSetting[],
): SettingValue[] {
  const setting = settings.find((known) => known.id === value.setting);
  const dependent = new Set(
    setting?.category === "model"
      ? settings
          .filter((known) => !MODEL_INDEPENDENT.includes(known.category))
          .map((known) => known.id)
      : [],
  );
  return [
    ...values.filter(
      (known) =>
        known.setting !== value.setting && !dependent.has(known.setting),
    ),
    value,
  ];
}
