import { create } from "zustand";

import type { GitResolutionFinding } from "@/features/git";

export type PageMergeSide = "ours" | "theirs";

/**
 * A property of a Page in conflict (DF-292): the value of each side as read,
 * `undefined` when the side has no such key.
 */
export interface PageMergeProperty {
  key: string;
  base: unknown;
  ours: unknown;
  theirs: unknown;
  /** Both sides changed the key from the base differently. */
  disputed: boolean;
  /** The merged value of a key that is not disputed. */
  merged: unknown;
}

/** Why a Page in conflict has no choice by properties. */
export type PageMergeUnavailableReason =
  | { type: "missing_stage" }
  | {
      type: "unreadable";
      stage: "base" | "ours" | "theirs";
      message: string;
    };

/**
 * A Page whose frontmatter is in conflict, as Svode merges it from the index
 * stages: the properties and the text below them, merged as text with the
 * conflict blocks of the editor, or why there is no choice by properties.
 */
export type PageMerge =
  | { type: "merged"; properties: PageMergeProperty[]; body: string }
  | { type: "unavailable"; reason: PageMergeUnavailableReason };

/** How the person decided a disputed property. */
export type PageMergeDecision =
  | { type: "ours" }
  | { type: "theirs" }
  /** A value set by the control of the property. */
  | { type: "value"; value: unknown };

/** The write of the decisions: in flight, or why the last one did not go. */
export type PageMergeWrite =
  | { status: "idle" }
  | { status: "writing" }
  | { status: "refused"; finding: GitResolutionFinding }
  | { status: "failed"; message: string };

export interface PageMergeState {
  merge: PageMerge;
  /** By disputed key. */
  decisions: Readonly<Record<string, PageMergeDecision>>;
  /** Nothing is disputed and the merged properties are taken. */
  accepted: boolean;
  write: PageMergeWrite;
}

interface PageMergeStore {
  /** By `pageMergeKey`. */
  merges: Record<string, PageMergeState>;
}

const usePageMergeStore = create<PageMergeStore>(() => ({ merges: {} }));

function pageMergeKey(spacePath: string, path: string): string {
  return `${spacePath}\0${path}`;
}

function update(
  spacePath: string,
  path: string,
  next: (state: PageMergeState) => PageMergeState,
) {
  const key = pageMergeKey(spacePath, path);
  usePageMergeStore.setState(({ merges }) => {
    const current = merges[key];
    if (!current) return { merges };
    return { merges: { ...merges, [key]: next(current) } };
  });
}

/** The disputed properties of `merge`, in the order of the Page. */
export function disputedPageMergeProperties(
  merge: PageMerge,
): PageMergeProperty[] {
  return merge.type === "merged"
    ? merge.properties.filter((property) => property.disputed)
    : [];
}

export function getPageMergeState(
  spacePath: string,
  path: string,
): PageMergeState | null {
  return (
    usePageMergeStore.getState().merges[pageMergeKey(spacePath, path)] ?? null
  );
}

export function usePageMergeState(
  spacePath: string,
  path: string | null | undefined,
): PageMergeState | null {
  return usePageMergeStore((state) =>
    path ? (state.merges[pageMergeKey(spacePath, path)] ?? null) : null,
  );
}

/** Starts the Page at `path` over with the merge of its loaded source. */
export function setPageMerge(
  spacePath: string,
  path: string,
  merge: PageMerge | null,
): void {
  const key = pageMergeKey(spacePath, path);
  usePageMergeStore.setState(({ merges }) => {
    const rest = { ...merges };
    delete rest[key];
    if (!merge) return { merges: rest };
    return {
      merges: {
        ...rest,
        [key]: {
          merge,
          decisions: {},
          accepted: false,
          write: { status: "idle" },
        },
      },
    };
  });
}

/** The merge follows its Page to a new path. */
export function movePageMerge(
  spacePath: string,
  from: string,
  to: string,
): void {
  const state = getPageMergeState(spacePath, from);
  if (!state) return;
  setPageMerge(spacePath, from, null);
  usePageMergeStore.setState(({ merges }) => ({
    merges: { ...merges, [pageMergeKey(spacePath, to)]: state },
  }));
}

/** Decides the disputed property `key`; `null` opens it again. */
export function decidePageMergeProperty(
  spacePath: string,
  path: string,
  key: string,
  decision: PageMergeDecision | null,
): void {
  update(spacePath, path, (state) => {
    const decisions = { ...state.decisions };
    if (decision) decisions[key] = decision;
    else delete decisions[key];
    return { ...state, decisions, write: { status: "idle" } };
  });
}

/** Takes the merged properties of a Page with nothing disputed, or not. */
export function acceptPageMerge(
  spacePath: string,
  path: string,
  accepted: boolean,
): void {
  update(spacePath, path, (state) => ({
    ...state,
    accepted,
    write: { status: "idle" },
  }));
}

export function setPageMergeWrite(
  spacePath: string,
  path: string,
  write: PageMergeWrite,
): void {
  update(spacePath, path, (state) => ({ ...state, write }));
}

/**
 * The properties are decided and wait for the write of the Page: every
 * disputed property has a decision, or nothing is disputed and the merged
 * properties are taken.
 */
export function pageMergeDecided(state: PageMergeState | null): boolean {
  if (!state || state.merge.type !== "merged") return false;
  const disputed = disputedPageMergeProperties(state.merge);
  if (disputed.length === 0) return state.accepted;
  return disputed.every((property) => property.key in state.decisions);
}

/** The value `decision` gives the disputed `property`. */
export function pageMergeDecisionValue(
  property: PageMergeProperty,
  decision: PageMergeDecision,
): unknown {
  if (decision.type === "value") return decision.value;
  return property[decision.type];
}

/**
 * Runs `listener` whenever the decisions of the Page at `path` change and
 * leave it decided, so the Page can be written.
 */
export function subscribePageMergeDecided(
  spacePath: string,
  path: string,
  listener: () => void,
): () => void {
  const key = pageMergeKey(spacePath, path);
  return usePageMergeStore.subscribe((state, previous) => {
    const next = state.merges[key];
    const before = previous.merges[key];
    if (!next || !pageMergeDecided(next)) return;
    if (
      before &&
      before.merge === next.merge &&
      before.decisions === next.decisions &&
      before.accepted === next.accepted
    )
      return;
    listener();
  });
}
