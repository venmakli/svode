import { expect, test } from "bun:test";

import {
  areAgentActorDraftsEqual,
  compareAgentActorsByDefault,
  createAgentActorDraft,
  firstInvalidAgentActorCreateStep,
  resolveAgentActorRuntimeStatus,
  validateAgentActorCreateDraft,
  validateAgentActorDraft,
} from "./agent-actor-draft";
import type { AgentActorRow } from "./agent-actor-types";

test("agent actor draft starts artifact-free with one default binding", () => {
  expect(createAgentActorDraft("/repo/space")).toEqual({
    adapters: [{ adapter: "codex", effort: null, model: null }],
    approvalMode: "ask",
    description: "",
    id: null,
    name: "",
    ownerPath: "/repo/space",
  });
});

test("agent actor draft requires a name and one unique binding", () => {
  const draft = createAgentActorDraft("/repo");
  draft.name = "  ";
  draft.adapters.push({ adapter: "codex", effort: null, model: null });
  expect(validateAgentActorDraft(draft)).toEqual({
    adapters: "binding_duplicate",
    name: "name_required",
  });
  draft.name = "Docs";
  draft.adapters = [];
  expect(validateAgentActorDraft(draft).adapters).toBe("binding_required");
});

test("create validation waits for binding inspection and fails closed on invalid selectors", () => {
  const draft = createAgentActorDraft("/repo");
  draft.name = "Docs";
  expect(
    validateAgentActorCreateDraft({
      draft,
      runtimePhase: "loading",
      validations: {},
    }).adapters,
  ).toBe("binding_inspection_pending");

  const invalid = validateAgentActorCreateDraft({
    draft,
    runtimePhase: "ready",
    validations: {
      codex: {
        issues: [{ code: "unknown_model", field: "model", message: "Bad" }],
        status: "unavailable",
      },
    },
  });
  expect(invalid.adapters).toBe("binding_invalid");
  expect(firstInvalidAgentActorCreateStep(invalid)).toBe("adapters");

  expect(
    validateAgentActorCreateDraft({
      draft,
      runtimePhase: "ready",
      validations: { codex: { issues: [], status: "valid" } },
    }),
  ).toEqual({ adapters: null, name: null });
});

test("dirty create comparison includes ordered adapter configuration", () => {
  const initial = createAgentActorDraft("/repo");
  const same = createAgentActorDraft("/repo");
  expect(areAgentActorDraftsEqual(initial, same)).toBe(true);
  same.adapters.push({ adapter: "claude-code", effort: null, model: null });
  expect(areAgentActorDraftsEqual(initial, same)).toBe(false);
  same.adapters = [...same.adapters].reverse();
  expect(areAgentActorDraftsEqual(initial, same)).toBe(false);
});

test("runtime status stays unchecked until valid bindings have evidence", () => {
  const bindings = [{ adapter: "codex" as const, effort: null, model: null }];
  expect(
    resolveAgentActorRuntimeStatus({
      bindings,
      diagnostics: {},
      validations: {},
    }),
  ).toBe("unchecked");
  expect(
    resolveAgentActorRuntimeStatus({
      bindings,
      diagnostics: {
        codex: {
          adapter: "codex",
          authenticated: true,
          code: null,
          executablePath: "/bin/codex",
          message: null,
          status: "ready",
          version: "1",
        },
      },
      validations: {},
    }),
  ).toBe("ready");
  expect(
    resolveAgentActorRuntimeStatus({
      bindings,
      diagnostics: {},
      validations: {
        codex: { issues: [], status: "unavailable" },
      },
    }),
  ).toBe("attention");
});

test("default order keeps own actors ahead of inherited actors", () => {
  const row = (name: string, inherited: boolean): AgentActorRow => ({
    actorRef: "agent:01arz3ndektsv4rrffq69g5fav",
    adapters: [{ adapter: "codex", effort: null, model: null }],
    approvalMode: "ask",
    description: null,
    id: "01arz3ndektsv4rrffq69g5fav",
    inherited,
    name,
    ownerLabel: inherited ? "root" : "space",
    ownerPath: inherited ? "/repo" : "/repo/space",
    runtimeStatus: "unchecked",
  });
  expect(
    compareAgentActorsByDefault(row("Zed", false), row("Ada", true)) < 0,
  ).toBe(true);
});
