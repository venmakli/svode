/** An agent id from the registry; a catalog may hold one this build does not know. */
export type AgentAdapterId = string;

/** A value of one setting as the agent names the setting and the value. */
export interface AgentActorSetting {
  setting: string;
  value: string;
}

/**
 * The one binding of an Actor: a concrete agent with the values of its
 * settings, or the participant's agent, which runs with the default agent
 * of the device that launches it.
 */
export type AgentActorBinding =
  | {
      agent: AgentAdapterId;
      kind: "agent";
      settings: readonly AgentActorSetting[];
    }
  | { kind: "participant" };

/** The device mode of an Actor, kept with the agent it was chosen for. */
export interface AgentActorMode {
  agent: AgentAdapterId;
  setting: string;
  value: string;
}

export interface AgentActorItem {
  actorRef: `agent:${string}`;
  binding: AgentActorBinding;
  description: string | null;
  id: string;
  inherited: boolean;
  /** The effective mode on this device; `null` is the agent's native default. */
  mode: AgentActorMode | null;
  name: string;
  ownerLabel: string;
  ownerPath: string;
  /** The version a write of this Agent expects: its definition and mode. */
  version: string;
}

export interface AgentActorCatalogDiagnostic {
  code: string;
  message: string;
  ownerPath: string;
}

/** A built-in agent a binding can name. */
export interface AgentActorAgentOption {
  id: AgentAdapterId;
  label: string;
}

export interface AgentActorCatalogSnapshot {
  agents: readonly AgentActorAgentOption[];
  diagnostics: readonly AgentActorCatalogDiagnostic[];
  fingerprints: Readonly<Record<string, string>>;
  launchSpacePath: string;
  items: readonly AgentActorItem[];
}

/** How an Agent runs: its binding and its device mode. */
export interface AgentActorBindingDraft {
  binding: AgentActorBinding;
  /** Kept as it is until the binding editor edits it. */
  mode: AgentActorMode | null;
}

/**
 * The binding an Agent's popover edits, with the version of the Agent when
 * the popover opened: a change of the Agent since then is a conflict.
 */
export interface AgentActorBindingEdit extends AgentActorBindingDraft {
  since: string;
}

/** What a write of an Agent puts into the catalog and on this device. */
export interface AgentActorState extends AgentActorBindingDraft {
  description: string | null;
  name: string;
}

export type AgentActorPersistenceOutcome =
  | { status: "committed" | "clean" }
  | {
      status: "pending";
      reason:
        | "policy_off"
        | "target_dirty"
        | "index_staged"
        | "target_changed"
        | "index_interference";
    }
  | { status: "failed"; message: string };

export interface AgentActorMutationApplied {
  /** The version of the Agent after the write; null once it is deleted. */
  version: string | null;
  persistence: AgentActorPersistenceOutcome;
  rootPointer: AgentActorPersistenceOutcome | null;
}

export type AgentActorDeleteReferenceState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | {
      phase: "ready";
      references: readonly AgentActorRoutineReference[];
      diagnostics: readonly AgentActorReferenceDiagnostic[];
    };

export interface AgentActorRoutineReference {
  routineId: string;
  path: string;
  title: string;
  ownerPath: string;
}

export interface AgentActorReferenceDiagnostic {
  ownerPath: string;
  path?: string | null;
  code: string;
  message: string;
}
