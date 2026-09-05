import { listen, type UnlistenFn } from "@/platform/native/events";
import { invokeCommand } from "@/platform/native/invoke";

export type AppVariableKindDto = "variable" | "secret";

export interface AppVariablesContextDto {
  projectPath: string;
  spaceId: string | null;
  ownerPath: string;
}

export interface AppVariablesCatalogDto {
  entries: Array<{
    name: string;
    kind: AppVariableKindDto;
    value?: string;
    hasValue: boolean;
    usedIn: Array<{ ownerDirectory: string; referenceName: string }>;
  }>;
  context?: Array<{
    referenceName: string;
    entryName: string;
    resolved: boolean;
    kind?: AppVariableKindDto;
  }>;
}

const APP_VARIABLES_CHANGED_EVENT = "app-settings:variables-changed";

export function getAppVariables(
  context?: AppVariablesContextDto,
): Promise<AppVariablesCatalogDto> {
  return invokeCommand("get_app_variables", { context });
}

export function upsertAppVariable(input: {
  name: string;
  kind: AppVariableKindDto;
  value?: string;
}): Promise<void> {
  return invokeCommand("upsert_app_variable", { input });
}

export function removeAppVariable(name: string): Promise<void> {
  return invokeCommand("remove_app_variable", { name });
}

export function setAppVariableBinding(input: {
  context: AppVariablesContextDto;
  referenceName: string;
  entryName: string;
}): Promise<void> {
  return invokeCommand("set_app_variable_binding", { input });
}

export function listenAppVariablesChanged(
  handler: () => void,
): Promise<UnlistenFn> {
  return listen<void>(APP_VARIABLES_CHANGED_EVENT, handler);
}
