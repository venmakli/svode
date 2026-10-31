import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
  agentRequests,
  useAgentRequestAvailability,
  useGitStore,
  type AgentRequest,
} from "@/features/git";
import * as m from "@/paraglide/messages.js";
import { loadUncommittedGroups } from "../api/agent-commit";
import {
  agentCommitRequest,
  groupsByRepository,
  type AreaPart,
} from "../model/agent-commit-request";
import {
  inspectionPaths,
  resolveInspectionScope,
  type ChangesTarget,
} from "../model/scope";
import { sessionArea, sessionAreaParts } from "../model/session-scope";

/**
 * «Зафиксировать с агентом» of a "Changes" window (Stage 11 1.10): whether
 * a chat session can take the request, and the request of the window's
 * area. In the window of a chat session it goes after the typed text of
 * that session's composer, elsewhere into a new chat session of the Space.
 * `prepare` composes it; the window then closes and `deliver` puts it into
 * the composer, which takes focus. The user sends it.
 */
export function useCommitWithAgent(target: ChangesTarget, open: boolean) {
  const sessionId =
    target.kind === "session" ? (target.work?.sessionId ?? null) : null;
  const available = useAgentRequestAvailability(
    { spacePath: target.spacePath, sessionId },
    open,
  );
  const [preparing, setPreparing] = useState(false);

  const prepare = useCallback(async (): Promise<AgentRequest | null> => {
    setPreparing(true);
    try {
      const sections = groupsByRepository(
        await loadUncommittedGroups(areaParts(target)),
      );
      if (sections.length === 0) {
        toast.info(m.changes_commit_with_agent_no_changes());
        return null;
      }
      return {
        spacePath: target.spacePath,
        sessionId,
        text: agentCommitRequest(sections),
        mark: "agent_commits",
      };
    } catch (error) {
      console.error("Failed to compose the request for the agent:", error);
      toast.error(m.changes_commit_with_agent_failed());
      return null;
    } finally {
      setPreparing(false);
    }
  }, [sessionId, target]);

  const deliver = useCallback((request: AgentRequest) => {
    const requests = agentRequests();
    if (!requests) return;
    void requests.submit(request).catch((error: unknown) => {
      console.error("Failed to put the request for the agent:", error);
      toast.error(m.changes_commit_with_agent_failed());
    });
  }, []);

  return { available, preparing, prepare, deliver };
}

/** The uncommitted paths of the window's area, Space by Space. */
function areaParts(target: ChangesTarget): AreaPart[] {
  const { statuses } = useGitStore.getState();
  if (target.kind === "session") {
    return sessionAreaParts(sessionArea(target, statuses)).map((part) => ({
      spacePath: part.spacePath,
      paths: part.paths,
    }));
  }
  return [
    {
      spacePath: target.spacePath,
      paths: inspectionPaths(
        resolveInspectionScope(target),
        statuses[target.spacePath],
      ),
    },
  ];
}
