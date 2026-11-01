import { expect, test } from "bun:test";

import type {
  AgentDeclaration,
  ChatAgent,
} from "@/features/agent-sessions/agent-settings-popover";

import {
  agentActorFacts,
  type AgentActorFactsSources,
} from "./agent-actor-facts";
import type { AgentActorRow } from "./agent-actor-types";

const codex: AgentActorRow = {
  actorRef: "agent:01arz3ndektsv4rrffq69g5fav",
  binding: {
    agent: "codex",
    kind: "agent",
    settings: [{ setting: "model", value: "gpt-6-sol" }],
  },
  description: null,
  id: "01arz3ndektsv4rrffq69g5fav",
  inherited: false,
  mode: { agent: "codex", setting: "mode", value: "agent" },
  name: "Reviewer",
  ownerLabel: "docs",
  ownerPath: "/repo/docs",
};
const participant: AgentActorRow = {
  ...codex,
  binding: { kind: "participant" },
  mode: null,
};

const declaration: AgentDeclaration = {
  agent: "codex",
  model: "gpt-6-sol",
  declaredAt: 1,
  agentVersion: "0.163.0",
  settings: [
    {
      id: "model",
      name: "Model",
      description: null,
      category: "model",
      currentValue: "gpt-6-sol",
      options: [
        { value: "gpt-6-sol", name: "GPT-6 Sol", description: null },
        { value: "gpt-5.6-luna", name: "GPT-5.6 Luna", description: null },
      ],
    },
    {
      id: "mode",
      name: "Approval",
      description: null,
      category: "mode",
      currentValue: "read-only",
      options: [
        { value: "read-only", name: "Read Only", description: null },
        { value: "agent", name: "Auto review", description: null },
      ],
    },
  ],
};

function offer(agent: string, value: ChatAgent["offer"]): ChatAgent {
  return { agent, name: agent, offer: value };
}

function sources(
  patch: Partial<AgentActorFactsSources> = {},
): AgentActorFactsSources {
  return {
    declarations: new Map([["codex", [declaration]]]),
    defaultAgent: null,
    known: new Set(["codex", "claude-code"]),
    offers: [offer("codex", { state: "available" })],
    ...patch,
  };
}

test("an Agent names its model and device mode in the agent's own words", () => {
  expect(agentActorFacts(codex, sources())).toEqual({
    bindable: true,
    model: "GPT-6 Sol",
    mode: { kind: "value", name: "Auto review" },
    readiness: "ready",
  });
  // Without a chosen mode the agent's default applies.
  expect(agentActorFacts({ ...codex, mode: null }, sources()).mode).toEqual({
    kind: "agent_default",
  });
  // A mode chosen for another agent does not apply.
  expect(
    agentActorFacts(
      { ...codex, mode: { agent: "hermes", setting: "mode", value: "x" } },
      sources(),
    ).mode,
  ).toEqual({ kind: "agent_default" });
});

test("an agent without modes has no approval mode, and the participant's agent none either", () => {
  const withoutModes: AgentDeclaration = {
    ...declaration,
    settings: [declaration.settings[0]!],
  };
  expect(
    agentActorFacts(
      { ...codex, mode: null },
      sources({ declarations: new Map([["codex", [withoutModes]]]) }),
    ).mode,
  ).toBeNull();
  expect(agentActorFacts(participant, sources()).mode).toBeNull();
});

test("without declarations the kept values show as they are", () => {
  expect(agentActorFacts(codex, sources({ declarations: new Map() }))).toEqual({
    bindable: true,
    model: "gpt-6-sol",
    mode: { kind: "value", name: "agent" },
    readiness: "ready",
  });
});

test("readiness follows the chat's offer of the agent", () => {
  const readiness = (value: ChatAgent["offer"] | null) =>
    agentActorFacts(
      codex,
      sources({ offers: value ? [offer("codex", value)] : [] }),
    ).readiness;
  expect(readiness({ state: "sign_in_required" })).toBe("sign_in_required");
  expect(
    readiness({
      state: "unavailable",
      reason: { code: "executable_missing", executable: "codex" },
    }),
  ).toBe("not_installed");
  expect(
    readiness({ state: "unavailable", reason: { code: "disabled" } }),
  ).toBe("unavailable");
  expect(readiness(null)).toBe("unavailable");
  expect(agentActorFacts(codex, sources({ offers: null })).readiness).toBe(
    null,
  );
  // An agent this version cannot bind, as a custom agent of a V1 catalog.
  const custom = agentActorFacts(
    {
      ...codex,
      binding: { agent: "custom-mine", kind: "agent", settings: [] },
    },
    sources(),
  );
  expect(custom.readiness).toBe("unavailable");
  expect(custom.bindable).toBe(false);
});

test("a kept value the agent no longer declares, or one of its mode's setting in the catalog, is marked", () => {
  expect(
    agentActorFacts(
      {
        ...codex,
        binding: {
          agent: "codex",
          kind: "agent",
          settings: [{ setting: "model", value: "gpt-4-old" }],
        },
      },
      sources(),
    ),
  ).toEqual({
    bindable: true,
    model: "gpt-4-old",
    mode: { kind: "value", name: "Auto review" },
    readiness: "value_not_declared",
  });
  expect(
    agentActorFacts(
      {
        ...codex,
        binding: {
          agent: "codex",
          kind: "agent",
          settings: [{ setting: "mode", value: "read-only" }],
        },
        mode: null,
      },
      sources(),
    ).readiness,
  ).toBe("value_not_declared");
  // A missing sign-in comes first.
  expect(
    agentActorFacts(
      {
        ...codex,
        binding: {
          agent: "codex",
          kind: "agent",
          settings: [{ setting: "model", value: "gpt-4-old" }],
        },
      },
      sources({ offers: [offer("codex", { state: "sign_in_required" })] }),
    ).readiness,
  ).toBe("sign_in_required");
});

test("the participant's agent is ready with the device's default agent", () => {
  expect(agentActorFacts(participant, sources()).readiness).toBe(
    "default_agent_missing",
  );
  expect(
    agentActorFacts(participant, sources({ defaultAgent: undefined }))
      .readiness,
  ).toBeNull();
  expect(
    agentActorFacts(
      participant,
      sources({ defaultAgent: { agent: "codex", settings: [] } }),
    ).readiness,
  ).toBe("ready");
  expect(
    agentActorFacts(
      participant,
      sources({
        defaultAgent: { agent: "claude-code", settings: [] },
        offers: [offer("claude-code", { state: "sign_in_required" })],
      }),
    ).readiness,
  ).toBe("sign_in_required");
});
