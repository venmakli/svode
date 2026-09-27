import { listen, type UnlistenFn } from "@/platform/native/events";
import { invokeCommand } from "@/platform/native/invoke";

export type AppVariableKindDto = "variable" | "secret";
export type VariableModeDto = "local" | "git";
export type VariableOwnerDto =
  | { scope: "project" }
  | { scope: "space"; id: string }
  | { scope: "global" };
export interface VariableSourceDto {
  owner: VariableOwnerDto;
  name: string;
}
export interface VariableScopeDto {
  projectPath: string;
  spaceId: string | null;
}
export interface AppVariablesContextDto extends VariableScopeDto {
  ownerPath: string;
}
export interface AppVariableUsageDto {
  ownerDirectory: string;
  referenceName: string;
}
export interface AppVariableEntryDto {
  name: string;
  kind: AppVariableKindDto;
  mode: VariableModeDto;
  revision: string;
  source: VariableSourceDto;
  ownerLabel: string;
  collision: boolean;
  inherited: boolean;
  value?: string;
  hasValue: boolean;
  usedIn: AppVariableUsageDto[];
}
export interface AppVariableReferenceDto {
  referenceName: string;
  entryName: string;
  source: VariableSourceDto;
  explicit: boolean;
  resolved: boolean;
  kind?: AppVariableKindDto;
  error?: string;
}
export type VariablesProblemCategoryDto =
  | "unavailable"
  | "legacy_format"
  | "invalid_config"
  | "blocked_journal"
  | "pending_save"
  | "unknown";
// Safe cause of an unreadable catalog; `owner` holds the affected files and is
// null only for errors outside the Variables model.
export interface VariablesProblemDto {
  category: VariablesProblemCategoryDto;
  code: string | null;
  owner: VariableOwnerDto | null;
  file: string | null;
  section: "variables" | "appVariableRegistry" | null;
  recoverable: boolean;
}
export interface VariableCatalogOwnerDto {
  owner: VariableOwnerDto;
  label: string;
  revision: string | null;
  problem: VariablesProblemDto | null;
}
export interface AppVariablesCatalogDto {
  entries: AppVariableEntryDto[];
  owners: VariableCatalogOwnerDto[];
  defaultOwner: VariableOwnerDto;
  bindingRevision: string;
  context?: AppVariableReferenceDto[];
}
export interface SaveVariableInputDto {
  source: VariableSourceDto;
  kind: AppVariableKindDto;
  mode: VariableModeDto;
  value?: string;
  operation: "create" | "edit";
  revision: string;
  keep?: VariableModeDto;
}

export type VariableGitOutcomeDto =
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
export interface VariableMutationResultDto {
  effects: Array<{
    ownerPath: string;
    config: VariableGitOutcomeDto;
    rootPointer: VariableGitOutcomeDto | null;
  }>;
}
export interface VariableRecoveryResultDto extends VariableMutationResultDto {
  completed: boolean;
}

const unknownProblem: VariablesProblemDto = {
  category: "unknown",
  code: null,
  owner: null,
  file: null,
  section: null,
  recoverable: false,
};
const categories = new Set<string>([
  "unavailable",
  "legacy_format",
  "invalid_config",
  "blocked_journal",
  "pending_save",
  "unknown",
]);
// Reads the structured `variables_problem` command error; any other failure
// stays unknown and its raw message is never shown.
export function toVariablesProblemDto(error: unknown): VariablesProblemDto {
  if (
    typeof error !== "object" ||
    error === null ||
    (error as { kind?: unknown }).kind !== "variables_problem"
  )
    return unknownProblem;
  const problem = (error as { problem?: Partial<VariablesProblemDto> }).problem;
  if (!problem || !categories.has(problem.category ?? ""))
    return unknownProblem;
  return {
    category: problem.category!,
    code: typeof problem.code === "string" ? problem.code : null,
    owner: problem.owner ?? null,
    file: typeof problem.file === "string" ? problem.file : null,
    section:
      problem.section === "variables" ||
      problem.section === "appVariableRegistry"
        ? problem.section
        : null,
    recoverable: problem.recoverable === true,
  };
}

const APP_VARIABLES_CHANGED_EVENT = "app-settings:variables-changed";
export function getAppVariables(
  context?: AppVariablesContextDto,
  scope?: VariableScopeDto,
  includeGlobal = false,
): Promise<AppVariablesCatalogDto> {
  return invokeCommand("get_app_variables", { context, scope, includeGlobal });
}
export function upsertAppVariable(
  input: SaveVariableInputDto & { scope?: VariableScopeDto },
): Promise<VariableMutationResultDto> {
  return invokeCommand("upsert_app_variable", { input });
}
export function removeAppVariable(input: {
  source: VariableSourceDto;
  scope?: VariableScopeDto;
  revision: string;
}): Promise<VariableMutationResultDto> {
  return invokeCommand("remove_app_variable", { input });
}
export function recoverAppVariables(
  source: VariableOwnerDto,
  scope?: VariableScopeDto,
): Promise<VariableRecoveryResultDto> {
  return invokeCommand("recover_app_variables", { source, scope });
}
export function setAppVariableBinding(input: {
  context: AppVariablesContextDto;
  referenceName: string;
  source: VariableSourceDto | null;
  revision: string;
}): Promise<void> {
  return invokeCommand("set_app_variable_binding", { input });
}
export function listenAppVariablesChanged(
  handler: () => void,
): Promise<UnlistenFn> {
  return listen<unknown>(APP_VARIABLES_CHANGED_EVENT, handler);
}
