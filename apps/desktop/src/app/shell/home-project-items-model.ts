import type { AgentSession } from "@/features/agent-sessions";
import type { NavigationResolvedItem } from "@/features/navigation";
import type { MainAreaObject } from "./main-area-object";
import { composeNow, type NowTemporary } from "./now-model";

/** A row under an expanded project of the Home sidebar. */
export type HomeProjectRow =
  | { kind: "pinned"; item: NavigationResolvedItem }
  | { kind: "active"; session: AgentSession }
  | { kind: "kept"; item: NavigationResolvedItem }
  | { kind: "temporary"; temporary: NowTemporary };

/**
 * The one flat list under an expanded project: its pins in pin order, then
 * its Now — active sessions, kept objects in keep order and the temporary
 * main area object. Only the active project has a main area object, so only
 * it has a temporary row. No object is repeated.
 */
export function homeProjectRows({
  pinned,
  kept,
  activeSessions,
  main,
}: {
  pinned: readonly NavigationResolvedItem[];
  kept: readonly NavigationResolvedItem[];
  activeSessions: readonly AgentSession[];
  /** The main area object of the active project; null for any other. */
  main: {
    object: MainAreaObject | null;
    described: NavigationResolvedItem | null;
  } | null;
}): HomeProjectRow[] {
  const now = composeNow({
    pinned,
    kept,
    activeSessions,
    mainObject: main?.object ?? null,
    described: main?.described ?? null,
  });
  return [
    ...pinned.map((item) => ({ kind: "pinned" as const, item })),
    ...now.active.map((session) => ({ kind: "active" as const, session })),
    ...now.kept.map((item) => ({ kind: "kept" as const, item })),
    ...(now.temporary
      ? [{ kind: "temporary" as const, temporary: now.temporary }]
      : []),
  ];
}
