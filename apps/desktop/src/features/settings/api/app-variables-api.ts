import * as transport from "@/platform/settings/app-variables-api";
import type {
  AppVariablesCatalog,
  AppVariablesContext,
  SaveVariableInput,
  VariableSource,
  VariableScope,
  VariableOwner,
} from "../model/app-variables";
export function getAppVariables(
  context?: AppVariablesContext,
  scope?: VariableScope,
  includeLibrary = false,
): Promise<AppVariablesCatalog> {
  return transport.getAppVariables(context, scope, includeLibrary);
}
export function upsertAppVariable(
  input: SaveVariableInput & { scope?: VariableScope },
) {
  return transport.upsertAppVariable(input);
}
export function removeAppVariable(input: {
  source: VariableSource;
  scope?: VariableScope;
  identity: string;
  revision: string;
}) {
  return transport.removeAppVariable(input);
}
export function recoverAppVariables(
  source?: VariableOwner,
  scope?: VariableScope,
) {
  return transport.recoverAppVariables(source, scope);
}
export function setAppVariableBinding(input: {
  context: AppVariablesContext;
  referenceName: string;
  source: VariableSource | null;
  revision: string;
}) {
  return transport.setAppVariableBinding(input);
}
export function listenAppVariablesChanged(handler: () => void) {
  return transport.listenAppVariablesChanged(handler);
}
