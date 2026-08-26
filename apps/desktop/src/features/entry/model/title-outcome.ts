import type { Entry } from "./types";

export function applyEntryTitleOutcome(current: Entry, outcome: Entry): Entry {
  return {
    ...current,
    path: outcome.path,
    warnings: outcome.warnings,
    meta: {
      ...current.meta,
      title: outcome.meta.title,
      updated: outcome.meta.updated,
    },
  };
}
