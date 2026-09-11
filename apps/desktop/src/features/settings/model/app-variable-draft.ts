import {
  ownerKey,
  type AppVariableEntry,
  type AppVariableKind,
  type AppVariablesCatalog,
  type VariableMode,
  type VariableOwner,
  type SaveVariableInput,
} from "./app-variables";
export interface VariableDraft {
  name: string;
  kind: AppVariableKind;
  storage: VariableMode;
  owner: VariableOwner;
  ownerLabel: string;
  revision: string;
  keep?: VariableMode;
  value: string;
  editing: boolean;
  preservesSecret: boolean;
  originalKind: AppVariableKind;
  originalStorage: VariableMode;
  explicitOrdinary: boolean;
}
export function createVariableDraft(
  name = "",
  catalog?: AppVariablesCatalog,
  owner = catalog?.defaultOwner ?? ({ scope: "global" } as VariableOwner),
): VariableDraft {
  const target = catalog?.owners.find(
    (o) => ownerKey(o.owner) === ownerKey(owner),
  );
  return {
    name,
    kind: "variable",
    storage: "local",
    owner,
    ownerLabel: target?.label ?? "Svode",
    revision: target?.revision ?? "",
    value: "",
    editing: false,
    preservesSecret: false,
    originalKind: "variable",
    originalStorage: "local",
    explicitOrdinary: true,
  };
}
export function editVariableDraft(entry: AppVariableEntry): VariableDraft {
  return {
    name: entry.name,
    kind: entry.kind,
    storage: entry.mode,
    owner: entry.source.owner,
    ownerLabel: entry.ownerLabel,
    revision: entry.revision,
    keep: entry.collision ? entry.mode : undefined,
    value: entry.kind === "variable" ? (entry.value ?? "") : "",
    editing: true,
    preservesSecret: entry.kind === "secret" && entry.hasValue,
    originalKind: entry.kind,
    originalStorage: entry.mode,
    explicitOrdinary: entry.kind === "variable",
  };
}
export const validVariableName = (name: string) =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
export function canSaveVariableDraft(draft: VariableDraft) {
  return (
    validVariableName(draft.name) &&
    Boolean(draft.revision) &&
    (draft.kind === "variable"
      ? draft.explicitOrdinary
      : draft.storage === "git" ||
        draft.preservesSecret ||
        draft.value.length > 0)
  );
}
export function variableDraftInput(draft: VariableDraft): SaveVariableInput {
  return {
    source: { owner: draft.owner, name: draft.name },
    mode: draft.storage,
    kind: draft.kind,
    operation: draft.editing ? "edit" : "create",
    revision: draft.revision,
    keep: draft.keep,
    value:
      draft.kind === "secret" && draft.value === "" ? undefined : draft.value,
  };
}
