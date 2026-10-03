import { expect, test } from "bun:test";
import type { McpClientStatus, McpStatus } from "../api";
import {
  initialToolsChoice,
  integrationParts,
  manualConfigJson,
  ownPartRemoval,
  SHARED_PART,
  sharedChoice,
  toolsEntries,
  toolsOffer,
  toolsPlan,
  type IntegrationActivity,
} from "./svode-integration";

const IDLE: IntegrationActivity = { pending: new Map(), failures: {} };

function client(
  id: string,
  installed: boolean,
  overrides: Partial<McpClientStatus> = {},
): McpClientStatus {
  return {
    id,
    name: id,
    found: true,
    installed,
    managed: installed,
    status: installed ? "installed" : "mcp_not_installed",
    configPath: `/home/${id}/config`,
    issues: [],
    ownPart: {
      kind: id === "claude-code" ? "plugin" : "mcp-entry",
      path: `/home/${id}/part`,
      state: installed ? "managed" : "absent",
    },
    limitation: null,
    ...overrides,
  };
}

function status(
  clients: McpClientStatus[],
  shared: Partial<McpStatus["sharedSkill"]> = {},
  server: McpStatus["server"]["status"] = "installed",
): McpStatus {
  const connectedReaders = clients
    .filter((candidate) => candidate.id === "codex" && candidate.installed)
    .map((candidate) => candidate.id);
  return {
    server: { status: server },
    clients,
    sharedSkill: {
      path: "/home/.agents/skills/svode",
      state: connectedReaders.length ? "managed" : "absent",
      readers: ["codex"],
      requiredBy: connectedReaders,
      ...shared,
    },
    manualConfig: {
      name: "svode",
      transport: "stdio",
      command: "/home/.svode/bin/svode-mcp",
      args: [],
      env: {},
    },
    doctor: { ok: true, messages: [], errors: [] },
  };
}

test("integration parts: nothing installed has no rows", () => {
  expect(
    integrationParts(
      status([client("claude-code", false), client("codex", false)]),
      IDLE,
    ),
  ).toEqual([]);
});

test("integration parts: installed parts list their agents and the shared skill its readers", () => {
  expect(
    integrationParts(
      status([client("claude-code", true), client("codex", true)]),
      IDLE,
    ),
  ).toEqual([
    { kind: "installed", part: "plugin", agents: ["claude-code"] },
    { kind: "installed", part: "mcp", agents: ["codex"] },
    { kind: "shared", readers: ["codex"] },
  ]);
});

test("integration parts: a problem gets its own row, fixable only when reconnecting completes it", () => {
  const rows = integrationParts(
    status([
      client("claude-code", true, {
        issues: [
          { code: "runtime_unavailable", message: "" },
          { code: "mcp_start_failed", message: "" },
        ],
      }),
      client("codex", true, {
        issues: [{ code: "incomplete", message: "" }],
      }),
    ]),
    IDLE,
  );
  expect(rows).toEqual([
    { kind: "shared", readers: ["codex"] },
    {
      kind: "problem",
      part: "plugin",
      agent: "claude-code",
      code: "mcp_start_failed",
      configPath: "/home/claude-code/config",
      fixable: false,
    },
    {
      kind: "problem",
      part: "mcp",
      agent: "codex",
      code: "incomplete",
      configPath: "/home/codex/config",
      fixable: true,
    },
  ]);
});

test("integration parts: a conflict and an installation outside Svode show without a connection", () => {
  const rows = integrationParts(
    status([
      client("claude-code", false, {
        ownPart: {
          kind: "plugin",
          path: "/home/.claude/plugins/svode",
          state: "external",
          source: "Claude marketplace",
        },
      }),
      client("codex", false, {
        issues: [
          { code: "custom_conflict", message: "" },
          { code: "client_policy_blocked", message: "" },
        ],
      }),
    ]),
    IDLE,
  );
  expect(rows.map((row) => row.kind)).toEqual(["external", "problem"]);
  expect(rows[0]).toEqual({
    kind: "external",
    part: "plugin",
    agent: "claude-code",
    source: "Claude marketplace",
  });
  expect(rows[1]).toEqual({
    kind: "problem",
    part: "mcp",
    agent: "codex",
    code: "custom_conflict",
    configPath: "/home/codex/config",
    fixable: false,
  });
});

test("integration parts: a running and a failed operation replace the state of their part", () => {
  const rows = integrationParts(
    status([client("claude-code", false), client("codex", true)]),
    {
      pending: new Map([
        ["claude-code", { kind: "install", client: "claude-code" }],
      ]),
      failures: {
        [SHARED_PART]: {
          operation: { kind: "remove_shared" },
          message: "busy",
        },
      },
    },
  );
  expect(rows).toEqual([
    { kind: "installed", part: "mcp", agents: ["codex"] },
    {
      kind: "failed",
      part: "shared",
      agent: null,
      operation: { kind: "remove_shared" },
      message: "busy",
    },
    {
      kind: "pending",
      part: "plugin",
      agent: "claude-code",
      operation: "install",
    },
  ]);
});

test("confirmation offers: turning on offers the kit with the shared skill and its other readers", () => {
  const fresh = status([client("claude-code", false), client("codex", false)], {
    readers: ["codex", "gemini-cli"],
  });
  expect(toolsOffer(fresh, "codex")).toEqual({
    agent: "codex",
    kit: "mcp_shared",
    sharedReused: false,
    alsoReaders: ["gemini-cli"],
    limitation: null,
  });
  expect(toolsOffer(fresh, "claude-code")).toEqual({
    agent: "claude-code",
    kit: "plugin",
    sharedReused: false,
    alsoReaders: [],
    limitation: null,
  });
  const reused = status([client("codex", false)], { state: "managed" });
  expect(toolsOffer(reused, "codex")?.sharedReused).toBe(true);
});

test("confirmation offers: nothing is offered to a connected, conflicting or runtime-less agent", () => {
  expect(toolsOffer(status([client("codex", true)]), "codex")).toBeNull();
  expect(
    toolsOffer(
      status([
        client("codex", false, {
          issues: [{ code: "skill_conflict", message: "" }],
        }),
      ]),
      "codex",
    ),
  ).toBeNull();
  expect(
    toolsOffer(status([client("codex", false)], {}, "not_found"), "codex"),
  ).toBeNull();
  expect(toolsOffer(status([client("codex", false)]), "hermes")).toBeNull();
  expect(toolsOffer(null, "codex")).toBeNull();
});

test("confirmation offers: turning off offers the shared skill only to its last dependent and reader", () => {
  const alone = status([client("claude-code", true), client("codex", true)]);
  expect(ownPartRemoval(alone, "codex")).toEqual({
    agent: "codex",
    part: "mcp",
    sharedRemovable: true,
  });
  expect(ownPartRemoval(alone, "claude-code")).toEqual({
    agent: "claude-code",
    part: "plugin",
    sharedRemovable: false,
  });
  const readByOthers = status([client("codex", true)], {
    readers: ["codex", "gemini-cli"],
  });
  expect(ownPartRemoval(readByOthers, "codex")?.sharedRemovable).toBe(false);
  expect(ownPartRemoval(alone, "hermes")).toBeNull();
  expect(ownPartRemoval(status([client("codex", false)]), "codex")).toBeNull();
});

test("the Svode tools dialog: lists found agents with their kit; conflicts and unsupported agents cannot be chosen", () => {
  const current = status([
    client("claude-code", false, {
      issues: [{ code: "custom_conflict", message: "" }],
    }),
    client("codex", true),
  ]);
  expect(toolsEntries(current, ["codex", "claude-code", "hermes"])).toEqual([
    { agent: "codex", kit: "mcp_shared", installed: true, blocked: null },
    {
      agent: "claude-code",
      kit: "plugin",
      installed: false,
      blocked: {
        reason: "conflict",
        code: "custom_conflict",
        configPath: "/home/claude-code/config",
      },
    },
    {
      agent: "hermes",
      kit: null,
      installed: false,
      blocked: { reason: "unsupported" },
    },
  ]);
});

test("the Svode tools dialog: the shared skill cannot be unchecked while a checked agent needs it", () => {
  const current = status([client("claude-code", true), client("codex", true)]);
  const entries = toolsEntries(current, ["codex", "claude-code"]);
  const initial = initialToolsChoice(current, entries);
  const unchecked = { ...initial, shared: false };
  expect(sharedChoice(current, entries, unchecked)).toEqual({
    installed: true,
    checked: true,
    locked: true,
    neededBy: ["codex"],
  });
  expect(toolsPlan(current, entries, unchecked)).toEqual({
    changes: [],
    operations: [],
  });

  const withoutCodex = {
    agents: { ...initial.agents, codex: false },
    shared: false,
  };
  expect(sharedChoice(current, entries, withoutCodex)).toEqual({
    installed: true,
    checked: false,
    locked: false,
    neededBy: [],
  });
  expect(toolsPlan(current, entries, withoutCodex)).toEqual({
    changes: [
      { kind: "remove", agent: "codex", kit: "mcp_shared" },
      { kind: "remove_shared", readers: ["codex"] },
    ],
    operations: [
      { kind: "remove", client: "codex" },
      { kind: "remove_shared" },
    ],
  });
});

test("the Svode tools dialog: installing an agent that reads the shared skill names its new readers", () => {
  const current = status(
    [client("claude-code", true), client("codex", false)],
    {
      readers: ["codex", "pi"],
    },
  );
  const entries = toolsEntries(current, ["codex", "claude-code"]);
  const choice = {
    agents: { codex: true, "claude-code": false },
    shared: false,
  };
  expect(toolsPlan(current, entries, choice)).toEqual({
    changes: [
      { kind: "install", agent: "codex", kit: "mcp_shared" },
      { kind: "remove", agent: "claude-code", kit: "plugin" },
      { kind: "add_shared", readers: ["codex", "pi"] },
    ],
    operations: [
      { kind: "remove", client: "claude-code" },
      { kind: "install", client: "codex" },
    ],
  });
});

test("the manual config is one standard mcpServers entry", () => {
  const config = status([]).manualConfig;
  expect(JSON.parse(manualConfigJson(config))).toEqual({
    mcpServers: {
      svode: { command: "/home/.svode/bin/svode-mcp", args: [] },
    },
  });
  expect(
    JSON.parse(manualConfigJson({ ...config, env: { A: "1" } })).mcpServers
      .svode.env,
  ).toEqual({ A: "1" });
});
