import {
  useActiveAgentSessions,
  useAgentSessionsReadProject,
} from "@/features/agent-sessions";
import {
  useDescribedNavigationItem,
  useNavigationState,
  useNowOrder,
} from "@/features/navigation";
import { useMainAreaObject, type MainAreaObject } from "./main-area-object";
import { composeNow, nowOrderRow, type NowRow } from "./now-model";

/**
 * The Now rows of the project whose navigation state is in scope, in the
 * one order its surfaces share in this window (DF-206). Until the state is
 * read the order waits: kept objects come first (R5). Until the project's
 * sessions are read (`sessionsRead`) its active sessions are unknown, so
 * the order and the hidden rows of the project are kept as they are.
 */
export function useNowRows(
  input: Parameters<typeof composeNow>[0],
  sessionsRead: boolean,
): NowRow[] {
  const projectPath = useNavigationState((state) =>
    state.loaded ? state.projectPath : null,
  );
  const rows = composeNow(input);
  const order = useNowOrder(projectPath, rows.map(nowOrderRow), sessionsRead);
  return order.map((index) => rows[index]);
}

/** Now of the active project with its main area object. */
export function useActiveProjectNow(): {
  rows: NowRow[];
  mainObject: MainAreaObject | null;
} {
  const pinned = useNavigationState((state) => state.pinned);
  const kept = useNavigationState((state) => state.kept);
  const projectPath = useNavigationState((state) => state.projectPath);
  const activeSessions = useActiveAgentSessions();
  const readProject = useAgentSessionsReadProject();
  const mainObject = useMainAreaObject();
  const described = useDescribedNavigationItem(
    mainObject?.kind === "artifact" ? mainObject.item : null,
  );
  const rows = useNowRows(
    { pinned, kept, activeSessions, mainObject, described },
    readProject !== null && readProject === projectPath,
  );
  return { rows, mainObject };
}

/**
 * Follows Now of the active project while no surface shows it, e.g. on
 * Home with the project collapsed, so a row that leaves and comes back
 * meanwhile comes last. Mount once in app composition.
 */
export function NowOrderTracker() {
  useActiveProjectNow();
  return null;
}
