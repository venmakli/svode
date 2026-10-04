import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentSessionSnapshotDto } from "@/platform/agent-runtime/agent-runtime-api";
import {
  contextUsage,
  currentOptionName,
  draftValuesToApply,
  filterOptions,
  sessionControls,
  withDraftValue,
  type SessionSetting,
} from "./session-controls";

/** The settings Codex declared in a recorded live session. */
const codex = (
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL("./fixtures/codex-turn.json", import.meta.url)),
      "utf8",
    ),
  ) as { final: AgentSessionSnapshotDto }
).final.settings;

test("the agent's settings go to the button, the mode line and blocks in its order", () => {
  const controls = sessionControls(codex);
  expect(controls.model?.id).toBe("model");
  expect(controls.reasoning?.id).toBe("reasoning_effort");
  expect(controls.mode?.id).toBe("mode");
  expect(controls.others.map((setting) => setting.id)).toEqual([
    "collaboration_mode",
    "fast-mode",
  ]);
  expect(currentOptionName(controls.model!)).toBe(
    controls.model!.options.find(
      (option) => option.value === controls.model!.currentValue,
    )!.name,
  );
});

test("an agent without declarations has no model, reasoning or mode", () => {
  expect(sessionControls([])).toEqual({
    model: null,
    reasoning: null,
    mode: null,
    others: [],
  });
});

test("legacy modes are the mode setting", () => {
  const legacy: SessionSetting = {
    id: "mode",
    name: "Mode",
    description: null,
    category: "mode",
    currentValue: "default",
    options: [
      { value: "default", name: "Manual", description: null },
      { value: "plan", name: "Plan", description: null },
    ],
  };
  const controls = sessionControls([legacy]);
  expect(controls.mode).toBe(legacy);
  expect(currentOptionName(legacy)).toBe("Manual");
});

test("the model search matches names, values and descriptions", () => {
  const options = [
    { value: "opus", name: "Opus", description: "Most capable" },
    { value: "sonnet", name: "Sonnet", description: null },
  ];
  expect(filterOptions(options, " ").length).toBe(2);
  expect(filterOptions(options, "son").map((option) => option.value)).toEqual([
    "sonnet",
  ]);
  expect(
    filterOptions(options, "capable").map((option) => option.value),
  ).toEqual(["opus"]);
});

test("the context indicator needs used and size and turns at 75% and 90%", () => {
  expect(contextUsage(null)).toBeNull();
  expect(contextUsage({ used: 10, size: 0, cost: null })).toBeNull();
  expect(contextUsage({ used: Number.NaN, size: 100, cost: null })).toBeNull();
  expect(contextUsage({ used: 74, size: 100, cost: null })?.level).toBe(
    "normal",
  );
  expect(contextUsage({ used: 75, size: 100, cost: null })?.level).toBe(
    "warning",
  );
  expect(contextUsage({ used: 90, size: 100, cost: null })?.level).toBe(
    "critical",
  );
  const usage = contextUsage({
    used: 53000,
    size: 200000,
    cost: { amount: 0.045, currency: "USD" },
  });
  expect(usage?.fraction).toBe(0.265);
  expect(usage?.cost).toEqual({ amount: 0.045, currency: "USD" });
});

test("a draft re-applies its values and never replaces an undeclared one silently", () => {
  const values = withDraftValue(
    withDraftValue([], { setting: "model", value: "gpt-5.5" }),
    { setting: "reasoning_effort", value: "high" },
  );
  const changed = withDraftValue(values, {
    setting: "model",
    value: "gpt-6-sol",
  });
  expect(changed).toEqual([
    { setting: "reasoning_effort", value: "high" },
    { setting: "model", value: "gpt-6-sol" },
  ]);
  const { apply, undeclared } = draftValuesToApply(
    [...changed, { setting: "effort", value: "max" }],
    codex,
  );
  expect(apply).toEqual(
    changed.filter(
      (value) =>
        codex.find((setting) => setting.id === value.setting)?.currentValue !==
        value.value,
    ),
  );
  expect(undeclared).toEqual([{ setting: "effort", value: "max" }]);
});
