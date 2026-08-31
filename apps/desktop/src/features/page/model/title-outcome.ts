import type { Page } from "./types";

export function applyPageTitleOutcome(current: Page, outcome: Page): Page {
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
