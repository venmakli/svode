export type { VariableMutationResultDto as VariableMutationResult } from "@/platform/settings/app-variables-api";

export type AppVariableKind = "variable" | "secret";
export type VariableMode = "local" | "git";
export type VariableOwner =
  | { scope: "project" }
  | { scope: "space"; id: string }
  | { scope: "global" };
export interface VariableSource {
  owner: VariableOwner;
  name: string;
}
export interface VariableScope {
  projectPath: string;
  spaceId: string | null;
}
export interface AppVariablesContext extends VariableScope {
  ownerPath: string;
}
export interface AppVariableUsage {
  ownerDirectory: string;
  referenceName: string;
}
export interface AppVariableEntry {
  name: string;
  kind: AppVariableKind;
  mode: VariableMode;
  revision: string;
  source: VariableSource;
  ownerLabel: string;
  collision: boolean;
  inherited: boolean;
  value?: string;
  hasValue: boolean;
  usedIn: AppVariableUsage[];
}
export interface AppVariableReference {
  referenceName: string;
  entryName: string;
  source: VariableSource;
  explicit: boolean;
  resolved: boolean;
  kind?: AppVariableKind;
  error?: string;
}
export interface VariableCatalogOwner {
  owner: VariableOwner;
  label: string;
  revision: string | null;
  error: string | null;
}
export interface AppVariablesCatalog {
  entries: AppVariableEntry[];
  owners: VariableCatalogOwner[];
  defaultOwner: VariableOwner;
  bindingRevision: string;
  context?: AppVariableReference[];
}
export interface SaveVariableInput {
  source: VariableSource;
  kind: AppVariableKind;
  mode: VariableMode;
  value?: string;
  operation: "create" | "edit";
  revision: string;
  keep?: VariableMode;
}
export const ownerKey = (owner: VariableOwner) =>
  owner.scope === "space" ? `space:${owner.id}` : owner.scope;
export const sourceKey = (source: VariableSource) =>
  `${ownerKey(source.owner)}:${source.name}`;
export const sameSource = (a: VariableSource, b: VariableSource) =>
  sourceKey(a) === sourceKey(b);
