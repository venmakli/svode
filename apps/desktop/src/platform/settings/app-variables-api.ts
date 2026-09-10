import { listen, type UnlistenFn } from "@/platform/native/events";
import { invokeCommand } from "@/platform/native/invoke";

export type AppVariableKindDto = "variable" | "secret";
export type VariableModeDto = "local" | "git";
export type VariableOwnerDto =
  | { scope: "project" }
  | { scope: "space"; id: string }
  | { scope: "library" };
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
  identity: string;
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
export interface VariableCatalogOwnerDto {
  owner: VariableOwnerDto;
  label: string;
  revision: string | null;
  error: string | null;
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
  identity?: string;
  revision: string;
  keep?: VariableModeDto;
}

const APP_VARIABLES_CHANGED_EVENT = "app-settings:variables-changed";
export function getAppVariables(
  context?: AppVariablesContextDto,
  scope?: VariableScopeDto,
): Promise<AppVariablesCatalogDto> {
  return invokeCommand("get_app_variables", { context, scope });
}
export function upsertAppVariable(
  input: SaveVariableInputDto & { scope?: VariableScopeDto },
): Promise<void> {
  return invokeCommand("upsert_app_variable", { input });
}
export function removeAppVariable(input: {
  source: VariableSourceDto;
  scope?: VariableScopeDto;
  identity: string;
  revision: string;
}): Promise<void> {
  return invokeCommand("remove_app_variable", { input });
}
export function recoverAppVariables(
  source?: VariableOwnerDto,
  scope?: VariableScopeDto,
): Promise<void> {
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
