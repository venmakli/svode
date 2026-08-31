import { create } from "zustand";
import type { Page } from "../model";

export interface PageTitleOutcome {
  key: number;
  scopePath: string;
  previousPath: string;
  page: Page;
}

interface PageTitleOutcomeState {
  titleOutcomeBySourceKey: Record<string, PageTitleOutcome>;
  publishTitleOutcome: (
    scopePath: string,
    previousPath: string,
    page: Page,
  ) => void;
}

let nextTitleOutcomeKey = 1;

function normalizePageIdentityPart(value: string) {
  return value.replaceAll("\\", "/").replace(/\/+$/g, "");
}

export function pageTitleOutcomeSourceKey(scopePath: string, path: string) {
  return `${normalizePageIdentityPart(scopePath)}\0${normalizePageIdentityPart(path)}`;
}

export const usePageTitleOutcomeStore = create<PageTitleOutcomeState>(
  (set) => ({
    titleOutcomeBySourceKey: {},
    publishTitleOutcome: (scopePath, previousPath, page) =>
      set((state) => ({
        titleOutcomeBySourceKey: {
          ...state.titleOutcomeBySourceKey,
          [pageTitleOutcomeSourceKey(scopePath, previousPath)]: {
            key: nextTitleOutcomeKey++,
            scopePath: normalizePageIdentityPart(scopePath),
            previousPath,
            page,
          },
        },
      })),
  }),
);
