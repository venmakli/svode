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
export interface VariableOwnerNames {
  rootPath: string | null;
  rootName: string | null;
  spaces: readonly { id: string; name: string }[];
}
// Owners of the open project are named by their display names; the catalog
// label (a folder path or name) remains only for other owners.
export function withOwnerNames(
  catalog: AppVariablesCatalog,
  projectPath: string | undefined,
  names: VariableOwnerNames,
): AppVariablesCatalog {
  if (!projectPath || projectPath !== names.rootPath) return catalog;
  const name = (owner: VariableOwner, label: string) =>
    (owner.scope === "project"
      ? names.rootName
      : owner.scope === "space"
        ? names.spaces.find((space) => space.id === owner.id)?.name
        : null) || label;
  return {
    ...catalog,
    owners: catalog.owners.map((item) => ({
      ...item,
      label: name(item.owner, item.label),
    })),
    entries: catalog.entries.map((entry) => ({
      ...entry,
      ownerLabel: name(entry.source.owner, entry.ownerLabel),
    })),
  };
}
export const ownerKey = (owner: VariableOwner) =>
  owner.scope === "space" ? `space:${owner.id}` : owner.scope;
export const sourceKey = (source: VariableSource) =>
  `${ownerKey(source.owner)}:${source.name}`;
export const sameSource = (a: VariableSource, b: VariableSource) =>
  sourceKey(a) === sourceKey(b);
