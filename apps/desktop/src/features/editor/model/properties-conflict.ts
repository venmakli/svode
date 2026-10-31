import { create } from "zustand";

import type {
  GitConflictPlace,
  GitConflictUnclearReason,
  GitResolutionFinding,
} from "@/features/git";

export type PropertiesSide = "ours" | "theirs";

/**
 * The frontmatter of a Page in conflict (1.F «Свойства Page»): marker lines
 * in it keep it out of Markdown IO, which rewrites YAML lines. The editor
 * shows the text after it; the block above the text resolves its places.
 */
export interface PropertiesConflict {
  /** The whole file the places come from. */
  source: string;
  markerSize: number;
  /** The places of the frontmatter; none when they are not told apart. */
  places: GitConflictPlace[];
  unclear: GitConflictUnclearReason | null;
  /** The text after the frontmatter and its places. */
  body: string;
  /** A place takes the closing `---` and the start of the text. */
  reachesText: boolean;
}

/** What the choices made so far give. */
export type PropertiesResolution =
  | { status: "choosing" }
  | { status: "checking" }
  | { status: "resolved"; frontmatter: string }
  | { status: "unresolved"; finding: GitResolutionFinding }
  | { status: "failed"; message: string };

export interface PropertiesConflictState {
  conflict: PropertiesConflict;
  choices: (PropertiesSide | null)[];
  resolution: PropertiesResolution;
}

interface PropertiesConflictStore {
  /** By document cache key. */
  conflicts: Record<string, PropertiesConflictState>;
}

const usePropertiesConflictStore = create<PropertiesConflictStore>(() => ({
  conflicts: {},
}));

function update(
  key: string,
  next: (state: PropertiesConflictState) => PropertiesConflictState | null,
) {
  usePropertiesConflictStore.setState(({ conflicts }) => {
    const current = conflicts[key];
    if (!current) return { conflicts };
    const updated = next(current);
    if (updated === current) return { conflicts };
    const rest = { ...conflicts };
    delete rest[key];
    return { conflicts: updated ? { ...rest, [key]: updated } : rest };
  });
}

/** The properties conflict of the document `key`, if it has one. */
export function getPropertiesConflict(
  key: string,
): PropertiesConflictState | null {
  return usePropertiesConflictStore.getState().conflicts[key] ?? null;
}

export function usePropertiesConflictState(
  key: string | null,
): PropertiesConflictState | null {
  return usePropertiesConflictStore((state) =>
    key ? (state.conflicts[key] ?? null) : null,
  );
}

/** Starts the document `key` over with the conflict of its loaded source. */
export function setPropertiesConflict(
  key: string,
  conflict: PropertiesConflict | null,
): void {
  usePropertiesConflictStore.setState(({ conflicts }) => {
    const rest = { ...conflicts };
    delete rest[key];
    if (!conflict) return { conflicts: rest };
    return {
      conflicts: {
        ...rest,
        [key]: {
          conflict,
          choices: conflict.places.map(() => null),
          resolution: { status: "choosing" },
        },
      },
    };
  });
}

/** The conflict follows its document to a new path. */
export function movePropertiesConflict(from: string, to: string): void {
  const state = getPropertiesConflict(from);
  if (!state) return;
  setPropertiesConflict(from, null);
  usePropertiesConflictStore.setState(({ conflicts }) => ({
    conflicts: { ...conflicts, [to]: state },
  }));
}

/**
 * The side chosen in place `index`; returns the choices when every place
 * has one, so the frontmatter they give can be checked.
 */
export function choosePropertiesSide(
  key: string,
  index: number,
  side: PropertiesSide,
): PropertiesSide[] | null {
  let complete: PropertiesSide[] | null = null;
  update(key, (state) => {
    const choices = state.choices.map((choice, at) =>
      at === index ? side : choice,
    );
    complete = choices.every((choice) => choice !== null)
      ? (choices as PropertiesSide[])
      : null;
    return {
      ...state,
      choices,
      resolution: complete ? { status: "checking" } : { status: "choosing" },
    };
  });
  return complete;
}

/**
 * What `choices` of `conflict` give; ignored once the document loaded
 * another source or the choices changed.
 */
export function setPropertiesResolution(
  key: string,
  conflict: PropertiesConflict,
  choices: readonly PropertiesSide[],
  resolution: PropertiesResolution,
): void {
  update(key, (state) =>
    state.conflict === conflict &&
    state.choices.every((choice, index) => choice === choices[index])
      ? { ...state, resolution }
      : state,
  );
}

/** The frontmatter to write before the body, once the block is resolved. */
export function resolvedFrontmatter(
  state: PropertiesConflictState | null,
): string | null {
  return state?.resolution.status === "resolved"
    ? state.resolution.frontmatter
    : null;
}
