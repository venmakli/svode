import { expect, test } from "bun:test";
import { setLocale } from "@/paraglide/runtime";
import type { GitUserPolicy } from "@/features/git";
import {
  GIT_POLICY_FIELDS,
  gitAutomationLeavesStructureUncommitted,
  gitAutomationPolicy,
  gitAutomationPreset,
  gitAutomationPresetOptions,
} from "./git-automation";

function combination(bits: number): GitUserPolicy {
  const [content, structural, system, sync] = [8, 4, 2, 1].map(
    (bit) => (bits & bit) !== 0,
  );
  return {
    autoCommitContent: content,
    autoCommitStructural: structural,
    autoCommitSystem: system,
    autoSync: sync,
  };
}

test("the preset follows from the combination of the four switches", () => {
  expect(GIT_POLICY_FIELDS.length).toBe(4);
  for (let bits = 0; bits < 16; bits += 1) {
    const expected =
      bits === 0 ? "manual" : bits === 15 ? "automatic" : "custom";
    expect(gitAutomationPreset(combination(bits))).toBe(expected);
  }
});

test("an existing combination of the three old switches shows as custom", () => {
  // The content switch is new and off: three switches on are not "Automatic".
  expect(gitAutomationPreset(combination(7))).toBe("custom");
  expect(gitAutomationPreset(combination(0))).toBe("manual");
});

test("manual and automatic set all switches, custom keeps them", () => {
  const current = combination(5);
  expect(gitAutomationPolicy("manual", current)).toEqual(combination(0));
  expect(gitAutomationPolicy("automatic", current)).toEqual(combination(15));
  expect(gitAutomationPolicy("custom", current)).toBe(current);
});

test("the presets carry their descriptions and Automatic needs a remote", async () => {
  await setLocale("ru", { reload: false });
  expect(gitAutomationPresetOptions(true)).toEqual([
    {
      value: "manual",
      label: "Вручную",
      description: "Коммиты и синхронизация — по кнопке.",
    },
    {
      value: "automatic",
      label: "Автоматически",
      description: "Рекомендуется для команд.",
      badge: "Экспериментальный",
      disabled: false,
    },
    {
      value: "custom",
      label: "Выборочно",
      description: "Свой набор переключателей.",
    },
  ]);
  expect(
    gitAutomationPresetOptions(false).find(
      (option) => option.value === "automatic",
    )?.disabled,
  ).toBe(true);
  await setLocale("en", { reload: false });
});

test("content commits with sync and no structural commits warn about pending structure", () => {
  for (let bits = 0; bits < 16; bits += 1) {
    const policy = combination(bits);
    expect(gitAutomationLeavesStructureUncommitted(policy)).toBe(
      policy.autoCommitContent &&
        policy.autoSync &&
        !policy.autoCommitStructural,
    );
  }
  expect(gitAutomationLeavesStructureUncommitted(combination(9))).toBe(true);
});
