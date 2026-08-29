import { create } from "zustand";
import type { Entry } from "../model";

export interface EntryTitleOutcome {
  key: number;
  scopePath: string;
  previousPath: string;
  entry: Entry;
}

interface EntryTitleOutcomeState {
  titleOutcomeBySourceKey: Record<string, EntryTitleOutcome>;
  publishTitleOutcome: (
    scopePath: string,
    previousPath: string,
    entry: Entry,
  ) => void;
}

let nextTitleOutcomeKey = 1;

function normalizeEntryIdentityPart(value: string) {
  return value.replaceAll("\\", "/").replace(/\/+$/g, "");
}

export function entryTitleOutcomeSourceKey(scopePath: string, path: string) {
  return `${normalizeEntryIdentityPart(scopePath)}\0${normalizeEntryIdentityPart(path)}`;
}

export const useEntryTitleOutcomeStore = create<EntryTitleOutcomeState>(
  (set) => ({
    titleOutcomeBySourceKey: {},
    publishTitleOutcome: (scopePath, previousPath, entry) =>
      set((state) => ({
        titleOutcomeBySourceKey: {
          ...state.titleOutcomeBySourceKey,
          [entryTitleOutcomeSourceKey(scopePath, previousPath)]: {
            key: nextTitleOutcomeKey++,
            scopePath: normalizeEntryIdentityPart(scopePath),
            previousPath,
            entry,
          },
        },
      })),
  }),
);
