import { expect, test } from "bun:test";
import {
  declaredSettings,
  withKeptValue,
  type AgentDeclaration,
} from "./declared-settings";
import type { SessionSetting } from "./session-controls";

function setting(
  id: string,
  category: SessionSetting["category"],
  current: string,
  values: string[],
): SessionSetting {
  return {
    id,
    name: id,
    description: null,
    category,
    currentValue: current,
    options: values.map((value) => ({ value, name: value, description: null })),
  };
}

const model = (current: string) =>
  setting("model", "model", current, ["grok-5", "grok-5-fast"]);
const mode = setting("mode", "mode", "default", ["default", "plan"]);
const effort = (values: string[]) =>
  setting("reasoning_effort", "thought_level", values[0], values);

function declaration(
  modelValue: string,
  settings: SessionSetting[],
  declaredAt: number,
): AgentDeclaration {
  return {
    agent: "grok-build",
    model: modelValue,
    settings,
    declaredAt,
    agentVersion: "1.0.70",
  };
}

test("nothing declared shows nothing", () => {
  expect(
    declaredSettings({ session: null, declarations: [], values: [] }),
  ).toEqual({ settings: null, recorded: false, withoutVariants: [] });
});

test("the last declarations show with their mark and the kept values", () => {
  const shown = declaredSettings({
    session: null,
    declarations: [
      declaration(
        "grok-5",
        [model("grok-5"), effort(["xhigh", "low"]), mode],
        2,
      ),
    ],
    values: [{ setting: "reasoning_effort", value: "low" }],
  });
  expect(shown.recorded).toBe(true);
  expect(shown.withoutVariants).toEqual([]);
  expect(shown.settings?.map((s) => s.currentValue)).toEqual([
    "grok-5",
    "low",
    "default",
  ]);
});

test("a chosen model takes the declarations kept for it, else its dependent settings wait", () => {
  const fast = declaration(
    "grok-5-fast",
    [model("grok-5-fast"), effort(["low"]), mode],
    1,
  );
  const latest = declaration(
    "grok-5",
    [model("grok-5"), effort(["xhigh", "low"]), mode],
    2,
  );
  const chosen = [{ setting: "model", value: "grok-5-fast" }];
  const kept = declaredSettings({
    session: null,
    declarations: [latest, fast],
    values: chosen,
  });
  expect(kept.settings?.[1].options.map((o) => o.value)).toEqual(["low"]);
  expect(kept.withoutVariants).toEqual([]);

  // A draft session that keeps its values until the first send.
  const waiting = declaredSettings({
    session: [model("grok-5"), effort(["xhigh", "low"]), mode],
    declarations: [latest],
    values: chosen,
  });
  expect(waiting.recorded).toBe(false);
  expect(waiting.withoutVariants).toEqual(["reasoning_effort"]);
  expect(waiting.settings?.[0].currentValue).toBe("grok-5-fast");
  expect(waiting.settings?.[1].currentValue).toBe("");
  expect(waiting.settings?.[1].options).toEqual([]);
  expect(waiting.settings?.[2]).toEqual(mode);

  const fromRecord = declaredSettings({
    session: [model("grok-5"), effort(["xhigh", "low"]), mode],
    declarations: [latest, fast],
    values: chosen,
  });
  expect(fromRecord.recorded).toBe(true);
  expect(fromRecord.settings?.map((s) => s.id)).toEqual([
    "model",
    "mode",
    "reasoning_effort",
  ]);
});

test("another model drops the kept values of the settings that follow it", () => {
  const settings = [model("grok-5"), effort(["xhigh", "low"]), mode];
  const values = [
    { setting: "reasoning_effort", value: "low" },
    { setting: "mode", value: "plan" },
  ];
  expect(
    withKeptValue(values, { setting: "model", value: "grok-5-fast" }, settings),
  ).toEqual([
    { setting: "mode", value: "plan" },
    { setting: "model", value: "grok-5-fast" },
  ]);
  expect(
    withKeptValue(
      values,
      { setting: "reasoning_effort", value: "xhigh" },
      settings,
    ),
  ).toEqual([
    { setting: "mode", value: "plan" },
    { setting: "reasoning_effort", value: "xhigh" },
  ]);
});
