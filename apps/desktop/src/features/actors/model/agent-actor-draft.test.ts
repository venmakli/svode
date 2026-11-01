import { expect, test } from "bun:test";

import {
  areAgentActorDraftsEqual,
  compareAgentActorsByDefault,
  createAgentActorDraft,
  firstInvalidAgentActorCreateStep,
  isAgentActorPortableUnchanged,
  validateAgentActorDraft,
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
  };
}

test("agent actor draft starts artifact-free without an agent", () => {
  expect(createAgentActorDraft("/repo/space")).toEqual({
    binding: null,
    description: "",
    id: null,
    mode: null,
    name: "",
    ownerPath: "/repo/space",
  });
});

test("an edit draft keeps the binding values and the device mode as they are", () => {
  const draft = createAgentActorDraft("/repo/space", item("Docs", false));
  expect(draft.binding).toEqual(item("Docs", false).binding);
  expect(draft.mode).toEqual(codexMode);
  expect(
    areAgentActorDraftsEqual(
      draft,
      createAgentActorDraft("/repo/space", item("Docs", false)),
    ),
  ).toBe(true);
});

test("changing the agent drops the values and the mode of the previous agent", () => {
  const draft = createAgentActorDraft("/repo/space", item("Docs", false));
  expect(withBindingAgent(draft, "codex")).toBe(draft);
  const claude = withBindingAgent(draft, "claude-code");
  expect(claude.binding).toEqual({
    agent: "claude-code",
    kind: "agent",
    settings: [],
  });
  expect(claude.mode).toBeNull();
  expect(areAgentActorDraftsEqual(draft, claude)).toBe(false);
  const participant = withParticipantBinding(draft);
  expect(participant.binding).toEqual({ kind: "participant" });
  expect(participant.mode).toBeNull();
  expect(withParticipantBinding(participant)).toBe(participant);
});

test("a value of the mode's setting never goes to the catalog", () => {
  const draft = createAgentActorDraft("/repo/space", item("Docs", false));
  draft.binding = {
    agent: "codex",
    kind: "agent",
    settings: [
      { setting: "model", value: "gpt-6.1-sol" },
      { setting: "mode", value: "agent-full-access" },
    ],
  };
  expect(withoutBindingSettings(draft, ["mode"]).binding).toEqual({
    agent: "codex",
    kind: "agent",
    settings: [{ setting: "model", value: "gpt-6.1-sol" }],
  });
  expect(withoutBindingSettings(draft, ["effort"])).toBe(draft);
});

test("a change of the device mode alone leaves the catalog as it is", () => {
  const actor = item("Docs", false);
  const draft = createAgentActorDraft("/repo/space", actor);
  draft.mode = { agent: "codex", setting: "mode", value: "read-only" };
  expect(isAgentActorPortableUnchanged(draft, actor)).toBe(true);
  expect(
    isAgentActorPortableUnchanged({ ...draft, name: "Docs 2" }, actor),
  ).toBe(false);
  expect(
    isAgentActorPortableUnchanged(withBindingAgent(draft, "hermes"), actor),
  ).toBe(false);
});

test("agent actor draft requires a name and an agent", () => {
  const draft = createAgentActorDraft("/repo");
  draft.name = "  ";
  const validation = validateAgentActorDraft(draft);
  expect(validation).toEqual({
    binding: "binding_required",
    name: "name_required",
  });
  expect(firstInvalidAgentActorCreateStep(validation)).toBe("identity");
  draft.name = "Docs";
  expect(firstInvalidAgentActorCreateStep(validateAgentActorDraft(draft))).toBe(
    "agent",
  );
  draft.binding = { agent: "codex", kind: "agent", settings: [] };
  expect(validateAgentActorDraft(draft)).toEqual({
    binding: null,
    name: null,
  });
  expect(
    validateAgentActorDraft({ ...draft, binding: { kind: "participant" } })
      .binding,
  ).toBeNull();
});

test("default order keeps own actors ahead of inherited actors", () => {
  expect(
    compareAgentActorsByDefault(item("Zed", false), item("Ada", true)) < 0,
  ).toBe(true);
});
