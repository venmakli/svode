import type {
  AgentActorBinding,
  AgentActorDraft,
  AgentActorItem,
} from "./agent-actor-types";

export type AgentActorCreateStep = "identity" | "agent" | "review";

export interface AgentActorDraftValidation {
  binding: "binding_required" | null;
  name: "name_required" | null;
}

/** A new draft starts without an agent; an edit draft keeps the Actor's. */
export function createAgentActorDraft(
  ownerPath: string,
  item?: AgentActorItem,
): AgentActorDraft {
  return {
    binding: item ? cloneBinding(item.binding) : null,
    description: item?.description ?? "",
    id: item?.id ?? null,
    mode: item?.mode ? { ...item.mode } : null,
    name: item?.name ?? "",
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

export function cloneAgentActorDraft(draft: AgentActorDraft): AgentActorDraft {
  return {
    ...draft,
    binding: draft.binding ? cloneBinding(draft.binding) : null,
    mode: draft.mode ? { ...draft.mode } : null,
  };
}

/** The agent of a binding; `null` for the participant's agent or none. */
export function bindingAgent(binding: AgentActorBinding | null): string | null {
  return binding?.kind === "agent" ? binding.agent : null;
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

/**
 * Bind the draft to the participant's agent, which runs with the default
 * agent of the device and its mode: no values and no device mode.
 */
export function withParticipantBinding(
  draft: AgentActorDraft,
): AgentActorDraft {
  if (draft.binding?.kind === "participant") return draft;
  return { ...draft, binding: { kind: "participant" }, mode: null };
}

/**
 * The draft without the binding's values of `settings`: the values of a
 * setting the agent declares in category `mode` never go to the catalog.
 */
export function withoutBindingSettings(
  draft: AgentActorDraft,
  settings: readonly string[],
): AgentActorDraft {
  const binding = draft.binding;
  if (
    binding?.kind !== "agent" ||
    !binding.settings.some((value) => settings.includes(value.setting))
  ) {
    return draft;
  }
  return {
    ...draft,
    binding: {
      ...binding,
      settings: binding.settings.filter(
        (value) => !settings.includes(value.setting),
      ),
    },
  };
}

/**
 * Whether the draft changes nothing of the Actor in the catalog: a change
 * of the device mode alone is a local-only write.
 */
export function isAgentActorPortableUnchanged(
  draft: AgentActorDraft,
  item: AgentActorItem,
): boolean {
  return (
    draft.id === item.id &&
    draft.name.trim() === item.name &&
    (draft.description.trim() || null) === item.description &&
    JSON.stringify(draft.binding) === JSON.stringify(item.binding)
  );
}

export function validateAgentActorDraft(
  draft: AgentActorDraft,
): AgentActorDraftValidation {
  return {
    binding:
      draft.binding === null ||
      (draft.binding.kind === "agent" && !draft.binding.agent)
        ? "binding_required"
        : null,
    name: draft.name.trim().length === 0 ? "name_required" : null,
  };
}

export function firstInvalidAgentActorCreateStep(
  validation: AgentActorDraftValidation,
): AgentActorCreateStep | null {
  if (validation.name) return "identity";
  if (validation.binding) return "agent";
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
  left: AgentActorItem,
  right: AgentActorItem,
): number {
  if (left.inherited !== right.inherited) return left.inherited ? 1 : -1;
  return (
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
    left.ownerPath.localeCompare(right.ownerPath) ||
    left.id.localeCompare(right.id)
  );
}

export function actorOwnerLabel(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const label = normalized.split(/[\\/]/).at(-1)?.trim();
  return label || path;
}
