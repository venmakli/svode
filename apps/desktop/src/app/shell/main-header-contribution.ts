import {
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ChangesTarget } from "@/features/changes";
import type { OpenWithGroup } from "@/features/external-open";

/**
 * What the open main surface adds to `WindowHeader`. The header owns the
 * order and the narrow-width behavior; nodes render in the header tree, so
 * they take their state through props rather than surface context.
 */
export interface MainHeaderContribution {
  /** ⓘ and ⋯ of the open object, right after the breadcrumbs. */
  objectActions?: ReactNode;
  /** View tools, collapsed into one popover button on a narrow row. */
  viewTools?: ReactNode;
  /** The object group of "Open with", ahead of the project applications. */
  openWith?: OpenWithGroup;
  /** The scope of "Changes". */
  changes?: ChangesTarget | null;
}

interface Entry {
  contribution: MainHeaderContribution;
}

const entries: Entry[] = [];
let current: MainHeaderContribution | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

// The latest mounted publisher wins; an earlier one shows again after it.
function emit() {
  const next = entries.at(-1)?.contribution ?? null;
  if (next === current) return;
  current = next;
  listeners.forEach((listener) => listener());
}

function sameChanges(
  a: ChangesTarget | null | undefined,
  b: ChangesTarget | null | undefined,
) {
  if (!a || !b) return !a && !b;
  return (
    a.kind === b.kind &&
    a.sourceShape === b.sourceShape &&
    a.spacePath === b.spacePath &&
    a.projectPath === b.projectPath &&
    a.sessionKey === b.sessionKey &&
    a.path === b.path &&
    a.name === b.name
  );
}

function sameContribution(
  a: MainHeaderContribution,
  b: MainHeaderContribution,
) {
  return (
    a.objectActions === b.objectActions &&
    a.viewTools === b.viewTools &&
    a.openWith === b.openWith &&
    sameChanges(a.changes, b.changes)
  );
}

export function useMainHeaderContribution() {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}

/**
 * Publishes the header elements of a main surface while it is mounted;
 * `null` publishes nothing, as a surface shown outside the main area does.
 */
export function usePublishMainHeader(
  contribution: MainHeaderContribution | null,
) {
  const entryRef = useRef<Entry | null>(null);
  const active = contribution !== null;
  useLayoutEffect(() => {
    if (!active) return;
    const entry: Entry = { contribution: {} };
    entries.push(entry);
    entryRef.current = entry;
    emit();
    return () => {
      entries.splice(entries.indexOf(entry), 1);
      entryRef.current = null;
      emit();
    };
  }, [active]);
  useLayoutEffect(() => {
    const entry = entryRef.current;
    if (
      !entry ||
      !contribution ||
      sameContribution(entry.contribution, contribution)
    )
      return;
    entry.contribution = contribution;
    emit();
  });
}

/** Component form of `usePublishMainHeader` for render props of features. */
export function PublishMainHeader(props: MainHeaderContribution) {
  usePublishMainHeader(props);
  return null;
}
