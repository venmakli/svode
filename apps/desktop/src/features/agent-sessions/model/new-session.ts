import type { AgentSessionScopeGroup } from "./types";

/** A registered Space by id; null is the project root. */
export interface NewSessionSpaceRef {
  spaceId: string | null;
}

/**
 * Where "New session" starts: the Space of the main area object when it can
 * take a session, otherwise why it cannot. There is no silent fallback to the
 * project root.
 */
export type NewSessionTarget =
  | { status: "ready"; scope: AgentSessionScopeGroup }
  | { status: "missing" | "broken"; name: string }
  | { status: "unknown" };

export function resolveNewSessionTarget(
  scopes: readonly AgentSessionScopeGroup[],
  space: NewSessionSpaceRef | null,
): NewSessionTarget {
  if (!space) return { status: "unknown" };
  const scope =
    space.spaceId === null
      ? scopes.find((candidate) => candidate.kind === "project")
      : scopes.find(
          (candidate) =>
            candidate.kind === "space" && candidate.scopeId === space.spaceId,
        );
  if (!scope) {
    return space.spaceId === null
      ? { status: "unknown" }
      : { status: "missing", name: space.spaceId };
  }
  if (scope.status !== "ready") {
    return { status: scope.status, name: scope.name };
  }
  return { status: "ready", scope };
}

/** Spaces to choose for a new session: the current one first, then the rest. */
export function newSessionScopeChoices(
  scopes: readonly AgentSessionScopeGroup[],
  current: AgentSessionScopeGroup | null,
): AgentSessionScopeGroup[] {
  if (!current) return [...scopes];
  return [
    current,
    ...scopes.filter((scope) => scope.scopeId !== current.scopeId),
  ];
}

/** A place a new session draft can start in, as its composer lists it. */
export interface DraftSpaceChoice {
  path: string;
  name: string;
  icon: string | null;
  kind: "project" | "space";
  /** Why the draft cannot start there; the choice is inactive. */
  unavailable: string | null;
}

/**
 * The places a draft lists instead of the Spaces of the active project,
 * e.g. the projects of Home. `choose` resolves whether the draft moves.
 */
export interface DraftSpaceChoices {
  choices: DraftSpaceChoice[];
  choose: (path: string) => Promise<boolean>;
}
