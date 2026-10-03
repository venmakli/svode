import type { CustomAgentDefinitionDto, CustomAgentSetupDto } from "../api";
import {
  actionFor,
  checkedState,
  type AgentRowActivity,
  type AgentRowState,
  type AgentRowView,
} from "./agent-row";

/** The custom agent form as the user types it. */
export interface CustomAgentDraft {
  name: string;
  command: string;
  /** One argument per line. */
  args: string;
  /** One `NAME=value` per line. */
  env: string;
}

export type CustomAgentDraftProblem =
  | { field: "name" }
  | { field: "command" }
  | { field: "env"; line: string };

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function lines(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function emptyCustomAgentDraft(): CustomAgentDraft {
  return { name: "", command: "", args: "", env: "" };
}

export function customAgentDraft(
  setup: CustomAgentDefinitionDto,
): CustomAgentDraft {
  return {
    name: setup.name,
    command: setup.command,
    args: setup.args.join("\n"),
    env: Object.entries(setup.env)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n"),
  };
}

/** The definition the draft describes, or the first thing to fix in it. */
export function customAgentDefinition(
  draft: CustomAgentDraft,
):
  | { definition: CustomAgentDefinitionDto; problem: null }
  | { definition: null; problem: CustomAgentDraftProblem } {
  const name = draft.name.trim();
  const command = draft.command.trim();
  if (!name) return { definition: null, problem: { field: "name" } };
  if (!command) return { definition: null, problem: { field: "command" } };
  const env: Record<string, string> = {};
  for (const line of lines(draft.env)) {
    const separator = line.indexOf("=");
    const variable = separator > 0 ? line.slice(0, separator).trim() : "";
    if (!VARIABLE_NAME.test(variable))
      return { definition: null, problem: { field: "env", line } };
    env[variable] = line.slice(separator + 1);
  }
  return {
    definition: { name, command, args: lines(draft.args), env },
    problem: null,
  };
}

/**
 * One state of a custom agent row: what happened in this window, then a
 * command that is not found, then the restriction of what the agent
 * declared, then ready or off.
 */
export function customAgentRowView(
  setup: CustomAgentSetupDto,
  activity: AgentRowActivity | null,
): AgentRowView {
  const state = customAgentState(setup, activity);
  return { state, warning: null, action: actionFor(false, state) };
}

function customAgentState(
  setup: CustomAgentSetupDto,
  activity: AgentRowActivity | null,
): AgentRowState {
  if (activity?.kind === "pending")
    return { kind: "pending", operation: activity.operation };
  if (activity?.kind === "failed")
    return {
      kind: "failed",
      operation: activity.operation,
      error: activity.error,
    };
  if (activity?.kind === "checked") return checkedState(activity.result, true);
  if (!setup.executablePath)
    return { kind: "command_missing", command: setup.command };
  if (setup.restriction)
    return { kind: "limited", restriction: setup.restriction };
  return { kind: setup.enabled ? "ready" : "disabled" };
}
