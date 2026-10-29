import { expect, test } from "bun:test";

import { agentContextIdleAgents } from "./idle-agents";
import type { AgentContextItemSource } from "./types";

const reader = (
  agent: string,
  overrides: Partial<AgentContextItemSource["readers"][number]> = {},
) => ({
  agent,
  disabled: false,
  supersededBy: null,
  unverified: false,
  missing: [],
  ...overrides,
});

test("agents that find an item but do not apply it follow its providers", () => {
  const idle = agentContextIdleAgents({
    idleReaders: ["hermes", "claude-code"],
    rejections: [],
    providers: ["codex"],
    sources: [
      {
        path: "/space/AGENTS.md",
        readers: [
          reader("codex"),
          reader("claude-code", { supersededBy: "/space/CLAUDE.md" }),
          reader("cursor", { disabled: true }),
        ],
        target: null,
      },
      {
        path: "/space/Agents.md",
        readers: [reader("grok-build", { supersededBy: "" })],
        target: "/space/AGENTS.md",
      },
    ],
  });

  expect(idle).toEqual([
    {
      agent: "claude-code",
      reason: { by: "/space/CLAUDE.md", kind: "superseded" },
    },
    { agent: "cursor", reason: { kind: "disabled" } },
    { agent: "grok-build", reason: { by: "", kind: "superseded" } },
    { agent: "hermes", reason: { kind: "off_in_svode" } },
  ]);
});

test("an agent that applies the item by one path is no idle agent", () => {
  expect(
    agentContextIdleAgents({
      idleReaders: [],
      rejections: [],
      providers: ["grok-build"],
      sources: [
        {
          path: "/space/AGENTS.md",
          readers: [reader("grok-build", { supersededBy: "/x" })],
          target: null,
        },
      ],
    }),
  ).toEqual([]);
});

test("an agent that does not load a skill says why, even when it is off in Svode", () => {
  const idle = agentContextIdleAgents({
    idleReaders: ["qwen-code", "hermes"],
    providers: ["cursor"],
    rejections: [
      { agent: "codex", missing: ["description"] },
      { agent: "qwen-code", missing: ["name", "description"] },
    ],
    sources: [
      {
        path: "/space/.agents/skills/nodesc",
        readers: [
          reader("codex", { missing: ["description"] }),
          reader("cursor"),
        ],
        target: null,
      },
    ],
  });

  expect(idle).toEqual([
    { agent: "codex", reason: { kind: "rejected", missing: ["description"] } },
    {
      agent: "qwen-code",
      reason: { kind: "rejected", missing: ["name", "description"] },
    },
    { agent: "hermes", reason: { kind: "off_in_svode" } },
  ]);
});
