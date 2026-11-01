import type {
  AgentActorAdapterDiagnostic,
  AgentActorBinding,
  AgentActorDraft,
  AgentActorRow,
  AgentActorRuntimeStatus,
} from "./agent-actor-types";

export type AgentActorCreateStep = "identity" | "adapters" | "review";

export interface AgentActorDraftValidation {
  binding: "binding_required" | null;
  name: "name_required" | null;
}

export function createAgentActorDraft(
  ownerPath: string,
  row?: AgentActorRow,
): AgentActorDraft {
  return {
    binding: row ? cloneBinding(row.binding) : agentBinding("codex"),
    description: row?.description ?? "",
    id: row?.id ?? null,
    mode: row?.mode ? { ...row.mode } : null,
    name: row?.name ?? "",
    ownerPath,
  };
}

/** A binding of `agent` without values: they belong to the agent. */
export function agentBinding(agent: string): AgentActorBinding {
  return { agent, kind: "agent", settings: [] };
}

export function cloneBinding(binding: AgentActorBinding): AgentActorBinding {
  return binding.kind === "agent"
    ? { ...binding, settings: binding.settings.map((value) => ({ ...value })) }
    : { kind: "participant" };
}

/** The agent of a binding; `null` for the participant's agent. */
export function bindingAgent(binding: AgentActorBinding): string | null {
  return binding.kind === "agent" ? binding.agent : null;
}

/**
 * Change the agent of the draft's binding. Its values and the device mode
 * belong to the previous agent, so the new binding starts without them.
 */
export function withBindingAgent(
  draft: AgentActorDraft,
  agent: string,
): AgentActorDraft {
  if (bindingAgent(draft.binding) === agent) return draft;
  return { ...draft, binding: agentBinding(agent), mode: null };
}

export function validateAgentActorDraft(
  draft: AgentActorDraft,
): AgentActorDraftValidation {
  return {
    binding:
      draft.binding.kind === "agent" && !draft.binding.agent
        ? "binding_required"
        : null,
    name: draft.name.trim().length === 0 ? "name_required" : null,
  };
}

export function firstInvalidAgentActorCreateStep(
  validation: AgentActorDraftValidation,
): AgentActorCreateStep | null {
  if (validation.name) return "identity";
  if (validation.binding) return "adapters";
  return null;
}

export function areAgentActorDraftsEqual(
  left: AgentActorDraft,
  right: AgentActorDraft,
): boolean {
  return (
    left.id === right.id &&
    left.ownerPath === right.ownerPath &&
    left.name === right.name &&
    left.description === right.description &&
    JSON.stringify(left.binding) === JSON.stringify(right.binding) &&
    JSON.stringify(left.mode) === JSON.stringify(right.mode)
  );
}

export function compareAgentActorsByDefault(
  left: AgentActorRow,
  right: AgentActorRow,
): number {
  if (left.inherited !== right.inherited) return left.inherited ? 1 : -1;
  return (
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
    left.ownerPath.localeCompare(right.ownerPath) ||
    left.id.localeCompare(right.id)
  );
}

/**
 * An agent found without a sign-in status command: the launch itself finds
 * whether the user is signed in, so its binding can run.
 */
export function isAgentActorFoundWithoutSignInStatus(
  diagnostic: AgentActorAdapterDiagnostic | undefined,
): boolean {
  return (
    diagnostic?.status === "unknown" &&
    diagnostic.code === "auth_status_unavailable"
  );
}

export function resolveAgentActorRuntimeStatus({
  binding,
  diagnostics,
  known,
}: {
  binding: AgentActorBinding;
  diagnostics: Readonly<Partial<Record<string, AgentActorAdapterDiagnostic>>>;
  /** Whether this version knows the agent of a concrete binding. */
  known: boolean;
}): AgentActorRuntimeStatus {
  if (binding.kind === "participant") return "unchecked";
  if (!known) return "attention";
  const diagnostic = diagnostics[binding.agent];
  if (isAgentActorFoundWithoutSignInStatus(diagnostic)) return "ready";
  if (!diagnostic || diagnostic.status === "unknown") return "unchecked";
  return diagnostic.status === "ready" ? "ready" : "attention";
}

export function actorOwnerLabel(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const label = normalized.split(/[\\/]/).at(-1)?.trim();
  return label || path;
}
