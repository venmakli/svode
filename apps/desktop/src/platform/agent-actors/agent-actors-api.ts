import { invokeCommand } from "@/platform/native/invoke";

export type AgentAdapterIdDto = "claude-code" | "codex";
export type AgentActorApprovalModeDto = "ask" | "auto" | "full";

export interface AgentActorBindingDto {
  adapter: AgentAdapterIdDto;
  model?: string | null;
  effort?: string | null;
}

export interface AgentActorDto {
  id: string;
  name: string;
  description?: string | null;
  adapters: AgentActorBindingDto[];
}

export interface AgentActorSelectOptionDto {
  value: string | null;
  label: string;
}

export interface AgentActorAdapterDescriptorDto {
  id: AgentAdapterIdDto;
  label: string;
  modelOptions: AgentActorSelectOptionDto[];
  defaultModelLabel: string;
  defaultEffortLabel: string;
}

export interface AgentActorBindingValidationDto {
  status: "valid" | "unavailable";
  issues: { code: string; field: string; message: string }[];
}

export interface AgentActorApprovalMappingDto {
  requested: AgentActorApprovalModeDto;
  native:
    | "codex_user_review"
    | "codex_auto_review"
    | "codex_full_access"
    | "claude_default"
    | "claude_auto"
    | "claude_bypass_permissions";
  label: string;
  effectiveBoundary: string;
  danger: boolean;
}

export interface AgentActorBindingRuntimeDto {
  actorId: string;
  ownerPath: string;
  bindingIndex: number;
  validation: AgentActorBindingValidationDto;
  effortOptions: AgentActorSelectOptionDto[];
  approval: AgentActorApprovalMappingDto;
  readiness: "unchecked";
}

export interface AgentActorsReadResultDto {
  resolution: {
    actors: {
      actor: AgentActorDto;
      ownerPath: string;
      approvalMode: AgentActorApprovalModeDto;
    }[];
    diagnostics: { ownerPath: string; code: string; message: string }[];
  };
  ownerFingerprints: Record<string, string>;
  adapterDescriptors: AgentActorAdapterDescriptorDto[];
  bindings: AgentActorBindingRuntimeDto[];
}

export interface AgentActorAdapterDiagnosticDto {
  adapter: AgentAdapterIdDto;
  status: "ready" | "missing" | "unauthenticated" | "unknown";
  executablePath: string | null;
  version: string | null;
  authenticated: boolean | null;
  code: string | null;
  message: string | null;
}

export interface AgentActorBindingInspectionDto {
  validation: AgentActorBindingValidationDto;
  effortOptions: AgentActorSelectOptionDto[];
  approval: AgentActorApprovalMappingDto;
}

export interface AgentActorRoutineReferenceDto {
  routineId: string;
  path: string;
  title: string;
  ownerPath: string;
}

export interface AgentActorDeleteReferencePreviewDto {
  actorId: string;
  references: AgentActorRoutineReferenceDto[];
  diagnostics: {
    ownerPath: string;
    path?: string | null;
    code: string;
    message: string;
  }[];
}

export type AgentActorMutationInputDto =
  | {
      kind: "create" | "update";
      actor: AgentActorDto;
      approvalMode: AgentActorApprovalModeDto;
    }
  | { kind: "delete"; actorId: string };

export type AgentActorPersistenceOutcomeDto =
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

export type AgentActorMutationResultDto =
  | {
      status: "applied";
      fingerprint: string;
      persistence: AgentActorPersistenceOutcomeDto;
      rootPointer?: AgentActorPersistenceOutcomeDto | null;
    }
  | { status: "stale"; fingerprint?: string | null }
  | { status: "blocked"; message: string };

export interface AgentActorCatalogSaveReviewDto {
  ownerPath: string;
  repositoryId: string;
  catalogFingerprint: string;
  targetStateFingerprint: string;
  rootPointerFingerprint?: string | null;
}

export type AgentActorCatalogSaveReviewResultDto =
  | { status: "clean" }
  | {
      status: "ready";
      review: AgentActorCatalogSaveReviewDto;
      requiresConsent: boolean;
    }
  | { status: "blocked"; message: string };

export type AgentActorCatalogSaveResultDto =
  | {
      status: "saved";
      catalog: AgentActorPersistenceOutcomeDto;
      rootPointer?: AgentActorPersistenceOutcomeDto | null;
    }
  | { status: "stale" }
  | { status: "blocked"; message: string };

export function getAgentActors(projectPath: string, spacePath: string) {
  return invokeCommand<AgentActorsReadResultDto>("agent_actors_get", {
    projectPath,
    spacePath,
    standalone: false,
  });
}

export function diagnoseAgentActorAdapter(
  targetSpacePath: string,
  adapter: AgentAdapterIdDto,
) {
  return invokeCommand<AgentActorAdapterDiagnosticDto>(
    "agent_actors_diagnose_adapter",
    { adapter, targetSpacePath },
  );
}

export function inspectAgentActorBinding(
  binding: AgentActorBindingDto,
  approvalMode: AgentActorApprovalModeDto,
) {
  return invokeCommand<AgentActorBindingInspectionDto>(
    "agent_actors_inspect_binding",
    { approvalMode, binding },
  );
}

export function generateAgentActorId() {
  return invokeCommand<string>("agent_actors_generate_id");
}

export function previewAgentActorDeleteReferences(
  projectPath: string,
  ownerPath: string,
  actorId: string,
) {
  return invokeCommand<AgentActorDeleteReferencePreviewDto>(
    "agent_actors_preview_delete_references",
    { actorId, ownerPath, projectPath },
  );
}

export function mutateAgentActor(
  projectPath: string,
  ownerPath: string,
  expectedFingerprint: string,
  mutation: AgentActorMutationInputDto,
) {
  return invokeCommand<AgentActorMutationResultDto>("agent_actors_mutate", {
    expectedFingerprint,
    mutation,
    ownerPath,
    projectPath,
  });
}

export function getAgentActorCatalogSaveReview(
  projectPath: string,
  ownerPath: string,
) {
  return invokeCommand<AgentActorCatalogSaveReviewResultDto>(
    "agent_actors_get_catalog_save_review",
    { ownerPath, projectPath },
  );
}

export function saveAgentActorCatalog(
  projectPath: string,
  ownerPath: string,
  review: AgentActorCatalogSaveReviewDto,
) {
  return invokeCommand<AgentActorCatalogSaveResultDto>(
    "agent_actors_save_catalog",
    { ownerPath, projectPath, review },
  );
}
