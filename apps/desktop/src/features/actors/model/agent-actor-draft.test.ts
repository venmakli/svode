import { expect, test } from "bun:test";

import {
  agentActorState,
  compareAgentActorsByDefault,
  isAgentActorPortableUnchanged,
  uniqueAgentActorName,
  withBindingAgent,
  withoutBindingSettings,
  withParticipantBinding,
} from "./agent-actor-draft";
import type { AgentActorItem } from "./agent-actor-types";

const codexMode = { agent: "codex", setting: "mode", value: "agent" };

function item(name: string, inherited: boolean): AgentActorItem {
  return {
    actorRef: "agent:01arz3ndektsv4rrffq69g5fav",
    binding: {
      agent: "codex",
      kind: "agent",
      settings: [{ setting: "model", value: "gpt-6.1-sol" }],
    },
    description: null,
    id: "01arz3ndektsv4rrffq69g5fav",
    inherited,
    mode: codexMode,
    name,
    ownerLabel: inherited ? "root" : "space",
    ownerPath: inherited ? "/repo" : "/repo/space",
    version: "v1",
  };
}

test("a write starts from the Agent's name, description, binding and device mode", () => {
  expect(agentActorState(item("Docs", false))).toEqual({
    binding: item("Docs", false).binding,
    description: null,
    mode: codexMode,
    name: "Docs",
  });
});

test("changing the agent drops the values and the mode of the previous agent", () => {
  const draft = agentActorState(item("Docs", false));
  expect(withBindingAgent(draft, "codex")).toBe(draft);
  const claude = withBindingAgent(draft, "claude-code");
  expect(claude.binding).toEqual({
    agent: "claude-code",
    kind: "agent",
    settings: [],
  });
  expect(claude.mode).toBeNull();
  expect(claude.name).toBe("Docs");
  const participant = withParticipantBinding(draft);
  expect(participant.binding).toEqual({ kind: "participant" });
  expect(participant.mode).toBeNull();
  expect(withParticipantBinding(participant)).toBe(participant);
});

test("a value of the mode's setting never goes to the catalog", () => {
  const draft = {
    ...agentActorState(item("Docs", false)),
    binding: {
      agent: "codex",
      kind: "agent" as const,
      settings: [
        { setting: "model", value: "gpt-6.1-sol" },
        { setting: "mode", value: "agent-full-access" },
      ],
    },
  };
  expect(withoutBindingSettings(draft, ["mode"]).binding).toEqual({
    agent: "codex",
    kind: "agent",
    settings: [{ setting: "model", value: "gpt-6.1-sol" }],
  });
  expect(withoutBindingSettings(draft, ["effort"])).toBe(draft);
});

test("a change of the device mode alone leaves the catalog as it is", () => {
  const base = agentActorState(item("Docs", false));
  const moded = {
    ...base,
    mode: { agent: "codex", setting: "mode", value: "read-only" },
  };
  expect(isAgentActorPortableUnchanged(moded, base)).toBe(true);
  expect(
    isAgentActorPortableUnchanged({ ...moded, name: "Docs 2" }, base),
  ).toBe(false);
  expect(
    isAgentActorPortableUnchanged({ ...moded, description: "Writes" }, base),
  ).toBe(false);
  expect(
    isAgentActorPortableUnchanged(withBindingAgent(moded, "hermes"), base),
  ).toBe(false);
});

test("a new Agent takes the default name, numbered while its catalog has it", () => {
  expect(uniqueAgentActorName("New agent", [])).toBe("New agent");
  expect(uniqueAgentActorName("New agent", ["Reviewer"])).toBe("New agent");
  expect(uniqueAgentActorName("New agent", ["new agent"])).toBe("New agent 2");
  expect(uniqueAgentActorName("New agent", ["New agent", "New agent 2"])).toBe(
    "New agent 3",
  );
});

test("default order keeps own actors ahead of inherited actors", () => {
  expect(
    compareAgentActorsByDefault(item("Zed", false), item("Ada", true)) < 0,
  ).toBe(true);
});
