import { expect, test } from "bun:test";

import { getLocale, setLocale } from "@/paraglide/runtime.js";

import {
  AGENT_ACTOR_READINESS,
  agentActorAgentLabel,
  agentActorModeLabel,
  agentActorReadinessLabel,
} from "./agent-actor-copy";

const label = (agent: string) => (agent === "codex" ? "Codex" : agent);
const facts = { bindable: true, model: null, mode: null, readiness: null };

test("Agent Actor copy follows the locale", async () => {
  const originalLocale = getLocale();
  try {
    await setLocale("ru", { reload: false });
    const copy = [
      agentActorAgentLabel({ kind: "participant" }, facts, label),
      agentActorModeLabel({ ...facts, mode: { kind: "agent_default" } }),
      ...AGENT_ACTOR_READINESS.map(agentActorReadinessLabel),
    ].join(" ");
    expect(copy.includes("Агент участника")).toBe(true);
    expect(copy.includes("По умолчанию агента")).toBe(true);
    expect(copy.includes("Агент по умолчанию не выбран")).toBe(true);
    expect(copy.includes("Значение больше не объявляется")).toBe(true);
    expect(/Participant|Ready|Not installed/.test(copy)).toBe(false);
  } finally {
    await setLocale(originalLocale, { reload: false });
  }
});

test("the Agent of a binding is its agent with the model, an unknown id as it is, or the participant's agent", async () => {
  const originalLocale = getLocale();
  try {
    await setLocale("en", { reload: false });
    const codex = { agent: "codex", kind: "agent" as const, settings: [] };
    expect(agentActorAgentLabel(codex, facts, label)).toBe("Codex");
    expect(
      agentActorAgentLabel(codex, { ...facts, model: "GPT-6 Sol" }, label),
    ).toBe("Codex · GPT-6 Sol");
    expect(
      agentActorAgentLabel(
        { agent: "custom-mine", kind: "agent", settings: [] },
        { ...facts, bindable: false },
        label,
      ),
    ).toBe("custom-mine");
    expect(agentActorAgentLabel({ kind: "participant" }, facts, label)).toBe(
      "Participant's agent",
    );
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
