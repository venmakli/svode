import type {
  AgentActorBinding,
  AgentActorBindingDraft,
  AgentActorBindingEdit,
  AgentActorItem,
  AgentActorState,
} from "./agent-actor-types";

/** A binding of `agent` without values: they belong to the agent. */
export function agentBinding(agent: string): AgentActorBinding {
  return { agent, kind: "agent", settings: [] };
}

/** What a write of `item` starts from. */
export function agentActorState(item: AgentActorItem): AgentActorState {
  return {
    binding: item.binding,
    description: item.description,
    mode: item.mode,
    name: item.name,
  };
}

/**
 * The binding an Agent's popover starts from, with the version of the Agent
 * when it opened.
 */
export function agentActorBindingEdit(
  item: AgentActorItem,
): AgentActorBindingEdit {
  return { binding: item.binding, mode: item.mode, since: item.version };
}

/** The agent of a binding; `null` for the participant's agent or none. */
export function bindingAgent(binding: AgentActorBinding | null): string | null {
  return binding?.kind === "agent" ? binding.agent : null;
}

/**
 * Change the agent of the draft's binding. Its values and the device mode
 * belong to the previous agent, so the new binding starts without them.
 */
export function withBindingAgent<Draft extends AgentActorBindingDraft>(
  draft: Draft,
  agent: string,
): Draft {
  if (bindingAgent(draft.binding) === agent) return draft;
  return { ...draft, binding: agentBinding(agent), mode: null };
}

/**
 * Bind the draft to the participant's agent, which runs with the default
 * agent of the device and its mode: no values and no device mode.
 */
export function withParticipantBinding<Draft extends AgentActorBindingDraft>(
  draft: Draft,
): Draft {
  if (draft.binding.kind === "participant") return draft;
  return { ...draft, binding: { kind: "participant" }, mode: null };
}

/**
 * The draft without the binding's values of `settings`: the values of a
 * setting the agent declares in category `mode` never go to the catalog.
 */
export function withoutBindingSettings<Draft extends AgentActorBindingDraft>(
  draft: Draft,
  settings: readonly string[],
): Draft {
  const binding = draft.binding;
  if (
    binding.kind !== "agent" ||
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
 * Whether `next` changes nothing of the Agent in the catalog from `base`: a
 * change of the device mode alone is a local-only write.
 */
export function isAgentActorPortableUnchanged(
  next: AgentActorState,
  base: AgentActorState,
): boolean {
  return (
    next.name.trim() === base.name.trim() &&
    (next.description?.trim() || null) === (base.description?.trim() || null) &&
    JSON.stringify(next.binding) === JSON.stringify(base.binding)
  );
}

/**
 * The name of a new Agent: `base`, or `base 2`, `base 3`, … while the
 * catalog it goes to has an Agent of that name.
 */
export function uniqueAgentActorName(
  base: string,
  taken: readonly string[],
): string {
  const names = new Set(taken.map((name) => name.trim().toLocaleLowerCase()));
  if (!names.has(base.toLocaleLowerCase())) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base} ${index}`;
    if (!names.has(candidate.toLocaleLowerCase())) return candidate;
  }
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
