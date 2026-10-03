import type {
  McpClientAttentionCode,
  McpClientStatus,
  McpManualConfig,
  McpStatus,
} from "../api";

/** Key of the shared skill among the keys of agent ids. */
export const SHARED_PART = "#shared-skill";

/** Something the integration does for one agent or for the shared skill. */
export type IntegrationOperation =
  | { kind: "install"; client: string }
  | { kind: "remove"; client: string }
  | { kind: "remove_shared" };

export function operationKey(operation: IntegrationOperation) {
  return operation.kind === "remove_shared" ? SHARED_PART : operation.client;
}

/** What the own part of an agent brings: its plugin, or an MCP entry that
 * goes with the shared skill when the agent reads it. */
export type IntegrationKit = "plugin" | "mcp_shared" | "mcp";

/** A conflicting installation: Svode leaves it unchanged. */
const CONFLICTS = new Set<McpClientAttentionCode>([
  "custom_conflict",
  "higher_precedence_conflict",
  "skill_conflict",
  "config_unreadable",
]);

// Problems a connected part can show with a fix: reconnecting completes it.
const FIXABLE = new Set<McpClientAttentionCode>([
  "incomplete",
  "repair_failed",
]);

export function kitOf(
  client: McpClientStatus,
  status: McpStatus,
): IntegrationKit {
  if (client.ownPart.kind === "plugin") return "plugin";
  return readsSharedSkill(client.id, status) ? "mcp_shared" : "mcp";
}

function readsSharedSkill(agent: string, status: McpStatus) {
  return status.sharedSkill.readers.includes(agent);
}

function runtimeReady(status: McpStatus) {
  return status.server.status === "installed";
}

// The first issue of the client a part row shows; an unavailable runtime is
// explained once for the block.
function problemOf(client: McpClientStatus) {
  return client.issues.find((issue) => issue.code !== "runtime_unavailable");
}

function conflictOf(client: McpClientStatus) {
  return client.issues.find((issue) => CONFLICTS.has(issue.code));
}

/** One row of the Svode integration block. */
export type IntegrationPartRow =
  | { kind: "installed"; part: "plugin" | "mcp"; agents: string[] }
  | {
      kind: "problem";
      part: "plugin" | "mcp";
      agent: string;
      code: McpClientAttentionCode;
      configPath: string | null;
      fixable: boolean;
    }
  | {
      kind: "external";
      part: "plugin" | "mcp";
      agent: string;
      source: string | null;
    }
  | {
      kind: "pending";
      part: "plugin" | "mcp" | "shared";
      agent: string | null;
      operation: IntegrationOperation["kind"];
    }
  | {
      kind: "failed";
      part: "plugin" | "mcp" | "shared";
      agent: string | null;
      operation: IntegrationOperation;
      message: string;
    }
  | { kind: "shared"; readers: string[] }
  | { kind: "shared_conflict"; path: string };

export interface IntegrationActivity {
  pending: ReadonlyMap<string, IntegrationOperation>;
  failures: Readonly<
    Record<string, { operation: IntegrationOperation; message: string }>
  >;
}

function partOf(client: McpClientStatus): "plugin" | "mcp" {
  return client.ownPart.kind === "plugin" ? "plugin" : "mcp";
}

/**
 * The installed parts with the agents they serve, then the parts with a
 * problem, an installation outside Svode or an operation of this window.
 * Agents without anything of Svode have no row.
 */
export function integrationParts(
  status: McpStatus,
  activity: IntegrationActivity,
): IntegrationPartRow[] {
  const healthy: Record<"plugin" | "mcp", string[]> = { plugin: [], mcp: [] };
  const rows: IntegrationPartRow[] = [];
  for (const client of status.clients) {
    const part = partOf(client);
    const pending = activity.pending.get(client.id);
    const failure = activity.failures[client.id];
    if (pending) {
      rows.push({
        kind: "pending",
        part,
        agent: client.id,
        operation: pending.kind,
      });
      continue;
    }
    if (failure) {
      rows.push({
        kind: "failed",
        part,
        agent: client.id,
        operation: failure.operation,
        message: failure.message,
      });
      continue;
    }
    if (client.ownPart.state === "external") {
      rows.push({
        kind: "external",
        part,
        agent: client.id,
        source: client.ownPart.source ?? null,
      });
      continue;
    }
    const problem = client.installed ? problemOf(client) : conflictOf(client);
    if (problem) {
      rows.push({
        kind: "problem",
        part,
        agent: client.id,
        code: problem.code,
        configPath: client.configPath ?? null,
        fixable: client.installed && FIXABLE.has(problem.code),
      });
      continue;
    }
    if (client.installed) healthy[part].push(client.id);
  }

  const shared: IntegrationPartRow[] = [];
  const sharedPending = activity.pending.get(SHARED_PART);
  const sharedFailure = activity.failures[SHARED_PART];
  if (sharedPending) {
    shared.push({
      kind: "pending",
      part: "shared",
      agent: null,
      operation: sharedPending.kind,
    });
  } else if (sharedFailure) {
    shared.push({
      kind: "failed",
      part: "shared",
      agent: null,
      operation: sharedFailure.operation,
      message: sharedFailure.message,
    });
  } else if (status.sharedSkill.state === "managed") {
    shared.push({ kind: "shared", readers: status.sharedSkill.readers });
  } else if (status.sharedSkill.state === "foreign") {
    shared.push({ kind: "shared_conflict", path: status.sharedSkill.path });
  }

  return [
    ...(["plugin", "mcp"] as const)
      .filter((part) => healthy[part].length)
      .map(
        (part): IntegrationPartRow => ({
          kind: "installed",
          part,
          agents: healthy[part],
        }),
      ),
    ...shared,
    ...rows,
  ];
}

/** What the confirmation of turning an agent on offers to add. */
export interface ToolsOffer {
  agent: string;
  kit: IntegrationKit;
  /** The shared skill the kit needs is already there. */
  sharedReused: boolean;
  /** Other found agents the new shared skill becomes available to. */
  alsoReaders: string[];
  limitation: string | null;
}

/**
 * Svode tools the agent can get: a found agent of the manager without its
 * own part, no conflict and a runtime to start.
 */
export function toolsOffer(
  status: McpStatus | null,
  agent: string,
): ToolsOffer | null {
  const client = status?.clients.find((candidate) => candidate.id === agent);
  if (!status || !client || !client.found || client.installed) return null;
  if (!runtimeReady(status) || client.ownPart.state === "external") return null;
  if (
    client.issues.some(
      (issue) =>
        CONFLICTS.has(issue.code) || issue.code === "client_policy_blocked",
    )
  )
    return null;
  const kit = kitOf(client, status);
  const sharedInstalled = status.sharedSkill.state === "managed";
  return {
    agent,
    kit,
    sharedReused: kit === "mcp_shared" && sharedInstalled,
    alsoReaders:
      kit === "mcp_shared" && !sharedInstalled
        ? status.sharedSkill.readers.filter((reader) => reader !== agent)
        : [],
    limitation: client.limitation,
  };
}

/** What the confirmation of turning an agent off offers to remove. */
export interface OwnPartRemoval {
  agent: string;
  part: "plugin" | "mcp";
  /** Removing this own part leaves the shared skill to no one else. */
  sharedRemovable: boolean;
}

/** The own part Svode can remove from the agent, if it has one. */
export function ownPartRemoval(
  status: McpStatus | null,
  agent: string,
): OwnPartRemoval | null {
  const client = status?.clients.find((candidate) => candidate.id === agent);
  if (!status || !client?.installed) return null;
  if (!["managed", "previous"].includes(client.ownPart.state)) return null;
  const { sharedSkill } = status;
  return {
    agent,
    part: partOf(client),
    sharedRemovable:
      sharedSkill.state === "managed" &&
      sharedSkill.requiredBy.every((reader) => reader === agent) &&
      sharedSkill.readers.every((reader) => reader === agent),
  };
}

/** One found agent in the Svode tools dialog. */
export interface ToolsEntry {
  agent: string;
  kit: IntegrationKit | null;
  installed: boolean;
  /** Why it cannot be checked or unchecked, if it cannot. */
  blocked:
    | { reason: "unsupported" }
    | { reason: "external"; source: string | null }
    | {
        reason: "conflict";
        code: McpClientAttentionCode;
        configPath: string | null;
      }
    | { reason: "policy" }
    | { reason: "runtime" }
    | null;
}

/**
 * The found agents in registry order: the ones the manager connects with
 * their kit and state, the others as not supported yet.
 */
export function toolsEntries(
  status: McpStatus,
  foundAgents: string[],
): ToolsEntry[] {
  return foundAgents.map((agent): ToolsEntry => {
    const client = status.clients.find((candidate) => candidate.id === agent);
    if (!client)
      return {
        agent,
        kit: null,
        installed: false,
        blocked: { reason: "unsupported" },
      };
    const base = {
      agent,
      kit: kitOf(client, status),
      installed: client.installed,
    };
    if (client.ownPart.state === "external")
      return {
        ...base,
        blocked: { reason: "external", source: client.ownPart.source ?? null },
      };
    // A connected agent can always give its own part back.
    if (client.installed) return { ...base, blocked: null };
    const conflict = conflictOf(client);
    if (conflict)
      return {
        ...base,
        blocked: {
          reason: "conflict",
          code: conflict.code,
          configPath: client.configPath ?? null,
        },
      };
    if (client.issues.some((issue) => issue.code === "client_policy_blocked"))
      return { ...base, blocked: { reason: "policy" } };
    if (!runtimeReady(status))
      return { ...base, blocked: { reason: "runtime" } };
    return { ...base, blocked: null };
  });
}

/** The choice of the dialog: agents to have their own part, and whether to
 * keep the shared skill. */
export interface ToolsChoice {
  agents: Readonly<Record<string, boolean>>;
  shared: boolean;
}

export function initialToolsChoice(
  status: McpStatus,
  entries: ToolsEntry[],
): ToolsChoice {
  return {
    agents: Object.fromEntries(
      entries.map((entry) => [entry.agent, entry.installed]),
    ),
    shared: status.sharedSkill.state === "managed",
  };
}

/** Checked agents whose own part needs the shared skill. */
export function sharedNeededBy(
  entries: ToolsEntry[],
  choice: ToolsChoice,
): string[] {
  return entries
    .filter((entry) => entry.kit === "mcp_shared" && choice.agents[entry.agent])
    .map((entry) => entry.agent);
}

/** The shared skill as the dialog shows it, if it has a row. */
export interface SharedChoice {
  installed: boolean;
  checked: boolean;
  /** Its state follows the agents: it is needed, or not there to remove. */
  locked: boolean;
  neededBy: string[];
}

export function sharedChoice(
  status: McpStatus,
  entries: ToolsEntry[],
  choice: ToolsChoice,
): SharedChoice | null {
  const installed = status.sharedSkill.state === "managed";
  if (!installed && !status.sharedSkill.readers.length) return null;
  const neededBy = sharedNeededBy(entries, choice);
  return {
    installed,
    checked: installed
      ? choice.shared || neededBy.length > 0
      : neededBy.length > 0,
    locked: !installed || neededBy.length > 0,
    neededBy,
  };
}

/** One line of the summary before applying the dialog. */
export type ToolsChange =
  | { kind: "install"; agent: string; kit: IntegrationKit }
  | { kind: "remove"; agent: string; kit: IntegrationKit }
  | { kind: "add_shared"; readers: string[] }
  | { kind: "remove_shared"; readers: string[] };

/** The changes of the choice and the operations that make them, in order:
 * own parts go before their shared skill. */
export function toolsPlan(
  status: McpStatus,
  entries: ToolsEntry[],
  choice: ToolsChoice,
): { changes: ToolsChange[]; operations: IntegrationOperation[] } {
  const changes: ToolsChange[] = [];
  const removes: IntegrationOperation[] = [];
  const installs: IntegrationOperation[] = [];
  for (const entry of entries) {
    if (entry.kit === null) continue;
    const chosen = Boolean(choice.agents[entry.agent]);
    if (chosen === entry.installed) continue;
    if (chosen) {
      changes.push({ kind: "install", agent: entry.agent, kit: entry.kit });
      installs.push({ kind: "install", client: entry.agent });
    } else {
      changes.push({ kind: "remove", agent: entry.agent, kit: entry.kit });
      removes.push({ kind: "remove", client: entry.agent });
    }
  }
  const shared = sharedChoice(status, entries, choice);
  const operations = [...removes, ...installs];
  if (shared && !shared.installed && shared.checked)
    changes.push({ kind: "add_shared", readers: status.sharedSkill.readers });
  if (shared && shared.installed && !shared.checked) {
    changes.push({
      kind: "remove_shared",
      readers: status.sharedSkill.readers,
    });
    operations.push({ kind: "remove_shared" });
  }
  return { changes, operations };
}

/** The standard `mcpServers` entry for configuring any client by hand. */
export function manualConfigJson(config: McpManualConfig) {
  const server = {
    command: config.command,
    args: config.args,
    ...(Object.keys(config.env).length ? { env: config.env } : {}),
  };
  return JSON.stringify({ mcpServers: { [config.name]: server } }, null, 2);
}
