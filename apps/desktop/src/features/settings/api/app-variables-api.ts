import {
  getAppVariables as getAppVariablesDto,
  listenAppVariablesChanged as listenAppVariablesChangedDto,
  removeAppVariable as removeAppVariableDto,
  setAppVariableBinding as setAppVariableBindingDto,
  upsertAppVariable as upsertAppVariableDto,
} from "@/platform/settings/app-variables-api";
import type {
  AppVariableKind,
  AppVariablesCatalog,
  AppVariablesContext,
} from "../model";

export function getAppVariables(
  context?: AppVariablesContext,
): Promise<AppVariablesCatalog> {
  return getAppVariablesDto(context);
}

export function upsertAppVariable(input: {
  name: string;
  kind: AppVariableKind;
  value?: string;
  intent?: "create" | "update-secret";
}) {
  return upsertAppVariableDto(input);
}

export function removeAppVariable(name: string) {
  return removeAppVariableDto(name);
}

export function setAppVariableBinding(input: {
  context: AppVariablesContext;
  referenceName: string;
  entryName: string;
}) {
  return setAppVariableBindingDto(input);
}

export function listenAppVariablesChanged(handler: () => void) {
  return listenAppVariablesChangedDto(handler);
}
