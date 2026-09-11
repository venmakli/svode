import type {
  AppVariableEntry,
  AppVariablesCatalog,
  VariableOwner,
} from "../app-variables";
export function variableFixture(
  input: Pick<AppVariableEntry, "name" | "kind"> & Partial<AppVariableEntry>,
  owner: VariableOwner = { scope: "project" },
): AppVariableEntry {
  return {
    mode: "local",
    revision: "r1",
    source: { owner, name: input.name },
    ownerLabel: owner.scope === "global" ? "Svode" : "Project",
    collision: false,
    inherited: false,
    hasValue: true,
    usedIn: [],
    ...input,
  };
}
export function catalogFixture(
  entries: AppVariableEntry[],
  defaultOwner: VariableOwner = { scope: "project" },
): AppVariablesCatalog {
  return {
    entries,
    defaultOwner,
    bindingRevision: "b1",
    owners: [
      defaultOwner,
      ...(defaultOwner.scope === "global"
        ? []
        : [{ scope: "global" } as const]),
    ].map((owner) => ({
      owner,
      label: owner.scope === "global" ? "Svode" : "Project",
      revision: "r1",
      error: null,
    })),
  };
}
