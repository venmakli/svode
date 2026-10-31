import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSpace } from "@/features/space";
import * as m from "@/paraglide/messages.js";
import { readGitAgentRules } from "../api/git-conflict-actions";
import { agentRequests } from "../model/agent-request";
import {
  conflictsForAgent,
  type ConflictAgentSituation,
  type ConflictForAgent,
} from "../model/conflict-agent-request";
import { conflictAgentRequest } from "../ui/conflict-agent-request";
import { useAgentRequestAvailability } from "./use-agent-request-availability";
import type { GitSyncWidget } from "./use-git-sync-widget";

export interface ResolveWithAgent {
  /**
   * The stop of the Dialog offers «Разрешить с агентом», or «Разобраться с
   * агентом» at an operation.
   */
  shown: boolean;
  /** A chat session can take the request; null while unknown. */
  available: boolean | null;
  preparing: boolean;
  resolve: () => Promise<void>;
}

/**
 * «Разрешить с агентом» of the Git sync Dialog (Stage 11 1.F) at a merge
 * stop, at files in conflict without an operation and at «Конфликт с
 * правками коллег», where it first runs the explicit sync that enters the
 * merge; «Разобраться с агентом» at a rebase, cherry-pick, revert or
 * sequencer, whose request names the operation and its step. The request
 * names the unresolved paths and the Git rules and goes into a new chat
 * session of the Space's default agent in the repository's directory,
 * marked so that the turn is not wrapped in a version. The Dialog closes;
 * the user sends the request.
 */
export function useResolveWithAgent(
  sync: GitSyncWidget,
  nameOf: (path: string) => string,
): ResolveWithAgent {
  const { stop, repositoryPath } = sync;
  const stopped = useMemo(() => stoppedConflicts(stop), [stop]);
  const shown =
    stop?.kind === "incoming" ||
    (!!stopped &&
      (stopped.situation.kind === "operation" || stopped.conflicts.length > 0));
  const place = useRepositoryPlace(repositoryPath, sync.spacePath);
  const available = useAgentRequestAvailability(
    { spacePath: place },
    sync.open && shown,
  );
  const [preparing, setPreparing] = useState(false);
  const { syncNow, setOpen } = sync;

  const resolve = useCallback(async () => {
    if (!shown) return;
    setPreparing(true);
    try {
      let handed = stopped;
      if (stop?.kind === "incoming") {
        // As «Синхронизировать и разрешить»: the merge state comes first,
        // then the paths it left unresolved.
        const outcome = await syncNow();
        handed =
          outcome?.type === "Conflict"
            ? {
                situation: { kind: "merge" },
                conflicts: conflictsForAgent(
                  outcome.files,
                  outcome.kinds,
                  outcome.service,
                ),
              }
            : null;
      }
      const requests = agentRequests();
      // An operation is handed over even with no file in conflict: the
      // person decides whether the agent finishes or aborts it.
      if (
        !handed ||
        (handed.situation.kind !== "operation" &&
          handed.conflicts.length === 0) ||
        !requests
      )
        return;
      const text = conflictAgentRequest({
        repository: repositoryPath,
        situation: handed.situation,
        conflicts: handed.conflicts,
        nameOf,
        rules: await readGitAgentRules(),
      });
      setOpen(false);
      await requests.submit({ spacePath: place, text, mark: "agent_commits" });
    } catch (error) {
      console.error("Failed to compose the request for the agent:", error);
      toast.error(m.git_resolve_with_agent_failed());
    } finally {
      setPreparing(false);
    }
  }, [nameOf, place, repositoryPath, setOpen, shown, stop, stopped, syncNow]);

  return { shown, available, preparing, resolve };
}

interface HandedConflicts {
  situation: ConflictAgentSituation;
  conflicts: ConflictForAgent[];
}

/**
 * What a stop that is a state of the repository hands the agent: the
 * situation and its unresolved conflicts.
 */
function stoppedConflicts(stop: GitSyncWidget["stop"]): HandedConflicts | null {
  if (stop?.kind === "conflict")
    return {
      situation: { kind: "merge" },
      conflicts: conflictsForAgent(stop.files, stop.kinds, stop.service),
    };
  if (stop?.kind === "unmerged")
    return {
      situation: { kind: "unmerged" },
      conflicts: conflictsForAgent(stop.files, stop.kinds),
    };
  if (stop?.kind === "operation")
    return {
      situation: {
        kind: "operation",
        operation: stop.operation,
        step: stop.step,
      },
      conflicts: conflictsForAgent(stop.files, stop.kinds),
    };
  return null;
}

/**
 * Where a session in the repository's directory starts: the project root
 * or the Space that is the repository. The canonical repository path may
 * differ from the path the project knows; the shown Space is then taken.
 */
function useRepositoryPlace(repositoryPath: string, shownPath: string) {
  const known = useSpace(
    (state) =>
      repositoryPath === state.activeRootPath ||
      (state.spaces ?? []).some((space) => space.path === repositoryPath),
  );
  return known ? repositoryPath : shownPath;
}
