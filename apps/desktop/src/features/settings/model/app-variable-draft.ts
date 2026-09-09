import type { AppVariableEntry, AppVariableKind } from "./app-variables";

export interface VariableDraft {
  name: string;
  kind: AppVariableKind;
  value: string;
  editing: boolean;
  preservesSecret: boolean;
}

export function createVariableDraft(name = ""): VariableDraft {
  return {
    name,
    kind: "variable",
    value: "",
    editing: false,
    preservesSecret: false,
  };
}

export function editVariableDraft(entry: AppVariableEntry): VariableDraft {
  return {
    name: entry.name,
    kind: entry.kind,
    value: entry.kind === "variable" ? (entry.value ?? "") : "",
    editing: true,
    preservesSecret: entry.kind === "secret" && entry.hasValue,
  };
}

export function validVariableName(name: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export function canSaveVariableDraft(draft: VariableDraft) {
  return (
    validVariableName(draft.name) &&
    (draft.kind === "variable" ||
      draft.preservesSecret ||
      draft.value.length > 0)
  );
}

export function variableDraftInput(draft: VariableDraft) {
  return {
    name: draft.name,
    kind: draft.kind,
    value:
      draft.kind === "secret" && draft.preservesSecret && draft.value === ""
        ? undefined
        : draft.value,
  };
}
