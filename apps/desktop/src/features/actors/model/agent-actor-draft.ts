import type {
  AgentActorAdapterDiagnostic,
  AgentActorBinding,
  AgentActorBindingValidation,
  AgentActorDraft,
  AgentActorRow,
  AgentActorRuntimeStatus,
} from "./agent-actor-types";

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
  adapters: string | null;
  name: string | null;
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
