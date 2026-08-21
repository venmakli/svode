import type {
  AgentActorAdapterDiagnostic,
  AgentActorBinding,
  AgentActorBindingValidation,
  AgentActorDraft,
  AgentActorRow,
  AgentActorRuntimeStatus,
} from "./agent-actor-types";

export type AgentActorCreateStep =
  | "identity"
  | "adapters"
  | "permissions"
  | "review";

export type AgentActorDraftRuntimePhase =
  | "idle"
  | "loading"
  | "ready"
  | "error";

export interface AgentActorDraftValidation {
  adapters:
    | "binding_required"
    | "binding_duplicate"
    | "binding_inspection_pending"
    | "binding_inspection_failed"
    | "binding_invalid"
    | null;
  name: "name_required" | null;
}

export function createAgentActorDraft(
  ownerPath: string,
  row?: AgentActorRow,
): AgentActorDraft {
  return {
    adapters: row
      ? row.adapters.map((binding) => ({ ...binding }))
      : [{ adapter: "codex", effort: null, model: null }],
    approvalMode: row?.approvalMode ?? "ask",
    description: row?.description ?? "",
    id: row?.id ?? null,
    name: row?.name ?? "",
    ownerPath,
  };
}

export function validateAgentActorDraft(draft: AgentActorDraft): {
  adapters: "binding_required" | "binding_duplicate" | null;
  name: "name_required" | null;
} {
  const name = draft.name.trim();
  const adapterIds = draft.adapters.map((binding) => binding.adapter);
  return {
    adapters:
      adapterIds.length === 0
        ? "binding_required"
        : new Set(adapterIds).size !== adapterIds.length
          ? "binding_duplicate"
          : null,
    name: name.length === 0 ? "name_required" : null,
  };
}

export function validateAgentActorCreateDraft({
  draft,
  runtimePhase,
  validations,
}: {
  draft: AgentActorDraft;
  runtimePhase: AgentActorDraftRuntimePhase;
  validations: Readonly<
    Partial<Record<AgentActorBinding["adapter"], AgentActorBindingValidation>>
  >;
}): AgentActorDraftValidation {
  const base = validateAgentActorDraft(draft);
  if (base.adapters) return base;

  if (runtimePhase === "loading" || runtimePhase === "idle") {
    return { ...base, adapters: "binding_inspection_pending" };
  }
  if (runtimePhase === "error") {
    return { ...base, adapters: "binding_inspection_failed" };
  }
  if (
    draft.adapters.some(
      (binding) => validations[binding.adapter]?.status !== "valid",
    )
  ) {
    return { ...base, adapters: "binding_invalid" };
  }
  return base;
}

export function firstInvalidAgentActorCreateStep(
  validation: AgentActorDraftValidation,
): AgentActorCreateStep | null {
  if (validation.name) return "identity";
  if (validation.adapters) return "adapters";
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
    left.approvalMode === right.approvalMode &&
    left.adapters.length === right.adapters.length &&
    left.adapters.every((binding, index) => {
      const candidate = right.adapters[index];
      return (
        candidate?.adapter === binding.adapter &&
        candidate.model === binding.model &&
        candidate.effort === binding.effort
      );
    })
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

export function resolveAgentActorRuntimeStatus({
  bindings,
  diagnostics,
  validations,
}: {
  bindings: readonly AgentActorBinding[];
  diagnostics: Readonly<
    Partial<Record<AgentActorBinding["adapter"], AgentActorAdapterDiagnostic>>
  >;
  validations: Readonly<
    Partial<Record<AgentActorBinding["adapter"], AgentActorBindingValidation>>
  >;
}): AgentActorRuntimeStatus {
  let unchecked = false;
  for (const binding of bindings) {
    const validation = validations[binding.adapter];
    if (validation?.status === "unavailable") continue;
    const diagnostic = diagnostics[binding.adapter];
    if (!diagnostic || diagnostic.status === "unknown") {
      unchecked = true;
      continue;
    }
    if (diagnostic.status === "ready") return "ready";
  }
  return unchecked ? "unchecked" : "attention";
}

export function actorOwnerLabel(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const label = normalized.split(/[\\/]/).at(-1)?.trim();
  return label || path;
}
