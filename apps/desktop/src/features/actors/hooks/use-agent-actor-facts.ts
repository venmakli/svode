import { useCallback, useEffect, useMemo, useState } from "react";

import {
  useChatAgents,
  useDefaultAgent,
  type AgentDeclaration,
} from "@/features/agent-sessions/agent-settings-popover";

import { loadAgentDeclarations } from "../api/agent-actors-api";
import { agentActorFacts } from "../model/agent-actor-facts";
import type {
  AgentActorAgentOption,
  AgentActorRow,
} from "../model/agent-actor-types";

/**
 * What the Agents collection shows of each Agent on this device (Stage 11
 * `03`): the model and mode names the agents declared last, and the
 * readiness of the binding's agent or of the default agent. The chat's
 * offer of the agents is read once while there are Agents or an editor is
 * open, and on demand, as after a sign-in; reading starts no agent process.
 */
export function useAgentActorFacts({
  agents,
  editing,
  rows,
}: {
  agents: readonly AgentActorAgentOption[];
  /** An Agent's editor is open and needs the agents' offers. */
  editing: boolean;
  rows: readonly AgentActorRow[] | null;
}) {
  const chat = useChatAgents(editing || (rows?.length ?? 0) > 0);
  const defaultAgent = useDefaultAgent();
  const participant = rows?.some((row) => row.binding.kind === "participant");
  const agentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const row of rows ?? []) {
      if (row.binding.kind === "agent") ids.add(row.binding.agent);
    }
    if (participant && defaultAgent.value) ids.add(defaultAgent.value.agent);
    return [...ids].sort();
  }, [defaultAgent.value, participant, rows]);
  const [declarations, setDeclarations] = useState<
    ReadonlyMap<string, readonly AgentDeclaration[]>
  >(new Map());
  // The declarations change with every session of the agents, so they are
  // read again with each catalog read.
  useEffect(() => {
    if (agentIds.length === 0) return;
    let current = true;
    void Promise.all(
      agentIds.map(
        async (agent) => [agent, await loadAgentDeclarations(agent)] as const,
      ),
    ).then((entries) => {
      if (current) setDeclarations(new Map(entries));
    });
    return () => {
      current = false;
    };
  }, [agentIds, rows]);
  const known = useMemo(
    () => new Set(agents.map((agent) => agent.id)),
    [agents],
  );
  const offers = chat.agents?.agents ?? null;
  const facts = useCallback(
    (row: AgentActorRow) =>
      agentActorFacts(row, {
        declarations,
        defaultAgent: defaultAgent.loaded ? defaultAgent.value : undefined,
        known,
        offers,
      }),
    [declarations, defaultAgent.loaded, defaultAgent.value, known, offers],
  );
  return {
    facts,
    /** The chat's offer of the agents; null while they are read. */
    offers: chat.agents,
    reloadOffers: chat.reload,
  };
}
