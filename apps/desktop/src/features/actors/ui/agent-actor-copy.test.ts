import { expect, test } from "bun:test";

import { getLocale, setLocale } from "@/paraglide/runtime.js";

import {
  AGENT_ACTOR_READINESS,
  agentActorAgentValue,
  agentActorModeLabel,
  agentActorReadinessLabel,
} from "./agent-actor-copy";

const facts = { model: null, mode: null, readiness: null };

test("Agent Actor copy follows the locale", async () => {
  const originalLocale = getLocale();
  try {
    await setLocale("ru", { reload: false });
    const copy = [
      agentActorModeLabel({ ...facts, mode: { kind: "agent_default" } }),
      ...AGENT_ACTOR_READINESS.map(agentActorReadinessLabel),
    ].join(" ");
    expect(copy.includes("По умолчанию агента")).toBe(true);
    expect(copy.includes("Агент по умолчанию не выбран")).toBe(true);
    expect(copy.includes("Значение больше не объявляется")).toBe(true);
    expect(/Participant|Ready|Not installed/.test(copy)).toBe(false);
  } finally {
    await setLocale(originalLocale, { reload: false });
  }
});

test("the Agent of a binding is its agent with the model, or the participant's agent", async () => {
  const originalLocale = getLocale();
  try {
    await setLocale("en", { reload: false });
    const codex = { agent: "codex", kind: "agent" as const, settings: [] };
    expect(agentActorAgentValue(codex, facts)).toEqual({
      agent: "codex",
      detail: null,
      kind: "agent",
    });
    expect(
      agentActorAgentValue(codex, { ...facts, model: "GPT-6 Sol" }),
    ).toEqual({ agent: "codex", detail: "GPT-6 Sol", kind: "agent" });
    expect(agentActorAgentValue({ kind: "participant" }, facts)).toEqual({
      kind: "participant",
    });
    expect(agentActorModeLabel(facts)).toBeNull();
    expect(
      agentActorModeLabel({
        ...facts,
        mode: { kind: "value", name: "Auto review" },
      }),
    ).toBe("Auto review");
  } finally {
    await setLocale(originalLocale, { reload: false });
  }
});
