export type AgentAdapterId = "claude-code" | "codex";
export type AgentActorApprovalMode = "ask" | "auto" | "full";
export type AgentActorRuntimeStatus = "ready" | "attention" | "unchecked";

export interface AgentActorBinding {
  adapter: AgentAdapterId;
  model: string | null;
  effort: string | null;
}

export interface AgentActorRow {
  actorRef: `agent:${string}`;
  adapters: readonly AgentActorBinding[];
  approvalMode: AgentActorApprovalMode;
  description: string | null;
  id: string;
  inherited: boolean;
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

export interface AgentActorSelectOption {
  label: string;
  value: string | null;
}

export interface AgentActorAdapterDescriptor {
  defaultEffortLabel: string;
  defaultModelLabel: string;
  id: AgentAdapterId;
  label: string;
  modelOptions: readonly AgentActorSelectOption[];
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

export interface AgentActorBindingValidation {
  issues: readonly {
    code: string;
    field: string;
    message: string;
  }[];
  status: "valid" | "unavailable";
}

export interface AgentActorApprovalMapping {
  danger: boolean;
  effectiveBoundary: string;
  label: string;
  native:
    | "codex_user_review"
    | "codex_auto_review"
    | "codex_full_access"
    | "claude_default"
    | "claude_auto"
    | "claude_bypass_permissions";
  requested: AgentActorApprovalMode;
}

export interface AgentActorCatalogSnapshot {
  adapterDescriptors: readonly AgentActorAdapterDescriptor[];
  bindingRuntime: Readonly<Record<string, readonly AgentActorBindingRuntime[]>>;
  diagnostics: readonly AgentActorCatalogDiagnostic[];
  fingerprints: Readonly<Record<string, string>>;
  launchSpacePath: string;
  rows: readonly AgentActorRow[];
}

export interface AgentActorBindingRuntime {
  approval: AgentActorApprovalMapping;
  effortOptions: readonly AgentActorSelectOption[];
  validation: AgentActorBindingValidation;
}

export interface AgentActorDraft {
  adapters: AgentActorBinding[];
  approvalMode: AgentActorApprovalMode;
  description: string;
  id: string | null;
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
