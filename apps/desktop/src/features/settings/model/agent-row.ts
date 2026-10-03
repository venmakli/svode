import type { AgentCheckDto, AgentInfoDto, AgentSetupDto } from "../api";

/** What the user did with one agent row. */
export type AgentOperation =
  | "enable"
  | "install"
  | "disable"
  | "update"
  | "remove"
  | "remove_custom"
  | "check"
  | "sign_in";

/** An operation error in the words of the adapter commands. */
export interface AgentOperationError {
  code: string | null;
  message: string;
  required?: number;
  version?: string;
  package?: string;
  name?: string;
}

/** A check result the row shows; an unavailable agent shows its facts instead. */
export type AgentCheckResult = Exclude<AgentCheckDto, { state: "unavailable" }>;

/** The latest thing that happened to a row in this window, if any. */
export type AgentRowActivity =
  | { kind: "pending"; operation: AgentOperation }
  | { kind: "failed"; operation: AgentOperation; error: AgentOperationError }
  | { kind: "checked"; result: AgentCheckResult };

type NodeProblem = Exclude<
  NonNullable<AgentSetupDto["adapter"]>["node"],
  { state: "ready" }
>;

/** The one state a row shows, in the priority of the settings contract. */
export type AgentRowState =
  | { kind: "deferred" }
  | { kind: "pending"; operation: AgentOperation }
  | { kind: "failed"; operation: AgentOperation; error: AgentOperationError }
  | { kind: "sign_in" }
  | { kind: "node"; node: NodeProblem; required: number }
  | { kind: "cli_unsupported"; minimum: string }
  | { kind: "adapter_missing" }
  | { kind: "adapter_outdated"; version: string }
  | { kind: "failed_to_start"; message: string }
  | { kind: "command_missing"; command: string }
  | {
      kind: "checked";
      name: string | null;
      version: string | null;
      /** What a custom agent declared; built-in agents are described. */
      declared: AgentInfoDto["capabilities"] | null;
    }
  | { kind: "limited"; restriction: "new_session_only" }
  | { kind: "disabled" }
  | { kind: "ready" };

export type AgentCliWarning =
  | { kind: "untested"; testedUpTo: string }
  | { kind: "unknown" };

export type AgentRowAction = "sign_in" | "update" | "retry";

export interface AgentRowView {
  state: AgentRowState;
  /** A CLI newer than tested or an unreadable version; shown in the same line. */
  warning: AgentCliWarning | null;
  action: AgentRowAction | null;
}

/** Found by the registry resolver; the rest is listed with an install hint. */
export function agentFound(setup: AgentSetupDto) {
  return setup.cli.status !== "missing";
}

export function agentDeferred(setup: AgentSetupDto) {
  return setup.verdict.state === "deferred";
}

/** Turning the agent on installs its adapter, so it asks first. */
export function enableInstallsAdapter(setup: AgentSetupDto) {
  return setup.adapter?.install.state === "not_installed";
}

/** Installing cannot start without Node.js of the required version. */
export function enableBlocked(setup: AgentSetupDto) {
  return (
    agentDeferred(setup) ||
    (enableInstallsAdapter(setup) && setup.adapter?.node.state !== "ready")
  );
}

/** The CLI version as a fact, without the name some CLIs print with it. */
export function cliVersionLabel(setup: AgentSetupDto) {
  const raw = setup.cli.version?.trim();
  if (!raw) return null;
  return /\d+\.\d+\.\d+[\w.-]*/.exec(raw)?.[0] ?? raw;
}

function cliWarning(setup: AgentSetupDto): AgentCliWarning | null {
  if (!setup.cliRange) return null;
  if (setup.cliVersion.state === "untested")
    return { kind: "untested", testedUpTo: setup.cliVersion.testedUpTo };
  if (setup.cliVersion.state === "unknown") return { kind: "unknown" };
  return null;
}

// Facts that need the user before the agent can run, most urgent first.
function requiredAction(setup: AgentSetupDto): AgentRowState | null {
  if (setup.cli.status === "unauthenticated") return { kind: "sign_in" };
  const adapter = setup.adapter;
  if (adapter && adapter.node.state !== "ready")
    return {
      kind: "node",
      node: adapter.node,
      required: adapter.requiredNodeMajor,
    };
  if (setup.cliVersion.state === "unsupported")
    return { kind: "cli_unsupported", minimum: setup.cliVersion.minimum };
  if (adapter?.install.state === "not_installed")
    return { kind: "adapter_missing" };
  if (adapter?.install.state === "needs_update")
    return { kind: "adapter_outdated", version: adapter.pinnedVersion };
  return null;
}

export function checkedState(
  result: AgentCheckResult,
  custom = false,
): AgentRowState {
  switch (result.state) {
    case "ready":
      return {
        kind: "checked",
        name: result.agent.name,
        version: result.agent.version,
        declared: custom ? result.agent.capabilities : null,
      };
    case "auth_required":
      return { kind: "sign_in" };
    case "failed_to_start":
      return { kind: "failed_to_start", message: result.message };
  }
}

export function actionFor(
  canSignIn: boolean,
  state: AgentRowState,
): AgentRowAction | null {
  switch (state.kind) {
    case "sign_in":
      return canSignIn ? "sign_in" : null;
    case "adapter_outdated":
      return "update";
    case "failed":
    case "failed_to_start":
      return "retry";
    default:
      return null;
  }
}

function stateFor(
  setup: AgentSetupDto,
  activity: AgentRowActivity | null,
): AgentRowState {
  if (agentDeferred(setup)) return { kind: "deferred" };
  if (activity?.kind === "pending")
    return { kind: "pending", operation: activity.operation };
  if (activity?.kind === "failed")
    return {
      kind: "failed",
      operation: activity.operation,
      error: activity.error,
    };
  if (activity?.kind === "checked") return checkedState(activity.result);
  return (
    requiredAction(setup) ?? { kind: setup.enabled ? "ready" : "disabled" }
  );
}

const WARNED_STATES = new Set<AgentRowState["kind"]>([
  "ready",
  "disabled",
  "checked",
]);

/** One state, one contextual action and an optional CLI version warning. */
export function agentRowView(
  setup: AgentSetupDto,
  activity: AgentRowActivity | null,
): AgentRowView {
  const state = stateFor(setup, activity);
  return {
    state,
    warning: WARNED_STATES.has(state.kind) ? cliWarning(setup) : null,
    action: actionFor(setup.canSignIn, state),
  };
}

/** An adapter command error or any other rejection, as the row shows it. */
export function agentOperationError(error: unknown): AgentOperationError {
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    return {
      code: typeof value.code === "string" ? value.code : null,
      message:
        typeof value.message === "string" ? value.message : String(error),
      ...(typeof value.required === "number"
        ? { required: value.required }
        : {}),
      ...(typeof value.version === "string" ? { version: value.version } : {}),
      ...(typeof value.package === "string" ? { package: value.package } : {}),
      ...(typeof value.name === "string" ? { name: value.name } : {}),
    };
  }
  return { code: null, message: String(error) };
}
