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
    identity: `id-${input.name}`,
    revision: "r1",
    source: { owner, name: input.name },
    ownerLabel: owner.scope === "library" ? "Svode" : "Project",
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
      ...(defaultOwner.scope === "library"
        ? []
        : [{ scope: "library" } as const]),
    ].map((owner) => ({
      owner,
      label: owner.scope === "library" ? "Svode" : "Project",
      revision: "r1",
      error: null,
    })),
  };
}
