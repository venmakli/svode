/** An agent id from the registry; a catalog may hold one this build does not know. */
export type AgentAdapterId = string;
export type AgentActorRuntimeStatus = "ready" | "attention" | "unchecked";

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

export interface AgentActorRow {
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
  runtimeStatus: AgentActorRuntimeStatus;
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

export interface AgentActorAdapterDiagnostic {
  adapter: AgentAdapterId;
  authenticated: boolean | null;
  code: string | null;
  executablePath: string | null;
  message: string | null;
  status: "ready" | "missing" | "unauthenticated" | "unknown";
  version: string | null;
}

export interface AgentActorCatalogSnapshot {
  agents: readonly AgentActorAgentOption[];
  diagnostics: readonly AgentActorCatalogDiagnostic[];
  fingerprints: Readonly<Record<string, string>>;
  launchSpacePath: string;
  rows: readonly AgentActorRow[];
}

export interface AgentActorDraft {
  binding: AgentActorBinding;
  description: string;
  id: string | null;
  /** Kept as it is until the binding editor edits it. */
  mode: AgentActorMode | null;
  name: string;
  ownerPath: string;
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
  fingerprint: string;
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
