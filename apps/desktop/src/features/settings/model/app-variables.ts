export type AppVariableKind = "variable" | "secret";

export interface AppVariablesContext {
  projectPath: string;
  spaceId: string | null;
  ownerPath: string;
}

export interface AppVariableUsage {
  ownerDirectory: string;
  referenceName: string;
}

export interface AppVariableEntry {
  name: string;
  kind: AppVariableKind;
  value?: string;
  hasValue: boolean;
  usedIn: AppVariableUsage[];
}

export interface AppVariableReference {
  referenceName: string;
  entryName: string;
  resolved: boolean;
  kind?: AppVariableKind;
}

export interface AppVariablesCatalog {
  entries: AppVariableEntry[];
  context?: AppVariableReference[];
}
