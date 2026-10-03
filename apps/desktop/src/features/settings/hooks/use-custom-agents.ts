import { useCallback, useEffect, useRef, useState } from "react";
import {
  addCustomAgent,
  checkAgent,
  checkCustomAgentDraft,
  listCustomAgents,
  listenCustomAgentsChanged,
  removeCustomAgent,
  setCustomAgentEnabled,
  updateCustomAgent,
  type AgentCheckDto,
  type CustomAgentDefinitionDto,
  type CustomAgentSetupDto,
} from "../api";
import {
  agentOperationError,
  type AgentOperation,
  type AgentOperationError,
  type AgentRowActivity,
} from "../model/agent-row";

type Activities = Readonly<Record<string, AgentRowActivity>>;

/**
 * The custom ACP agents of this device and what the user does with them.
 * Reading them only looks their commands up; a check starts the agent and
 * closes it. Changes made in any window are read again here.
 */
export function useCustomAgents() {
  const [agents, setAgents] = useState<CustomAgentSetupDto[] | null>(null);
  const [activities, setActivities] = useState<Activities>({});
  const mountedRef = useRef(true);
  const loadGenerationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setActivity = useCallback(
    (agent: string, activity: AgentRowActivity | null) => {
      if (!mountedRef.current) return;
      setActivities((current) => {
        const next = { ...current };
        if (activity) next[agent] = activity;
        else delete next[agent];
        return next;
      });
    },
    [],
  );

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    try {
      const next = await listCustomAgents();
      if (!mountedRef.current || generation !== loadGenerationRef.current)
        return;
      setAgents(next);
    } catch (error) {
      console.error("Failed to read custom agents:", error);
      if (!mountedRef.current || generation !== loadGenerationRef.current)
        return;
      setAgents((current) => current ?? []);
    }
  }, []);

  // Subscribed before the first read, so a change in another window between
  // the two is not missed.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenCustomAgentsChanged(() => {
      if (!disposed) void load();
    })
      .then((next) => {
        if (disposed) next();
        else unlisten = next;
      })
      .catch(() => {})
      .finally(() => {
        if (!disposed) void load();
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [load]);

  const replace = useCallback((next: CustomAgentSetupDto) => {
    if (!mountedRef.current) return;
    setAgents((current) => {
      if (!current) return [next];
      return current.some((agent) => agent.agent === next.agent)
        ? current.map((agent) => (agent.agent === next.agent ? next : agent))
        : [...current, next];
    });
  }, []);

  const run = useCallback(
    async (
      agent: string,
      operation: AgentOperation,
      command: () => Promise<void>,
    ) => {
      setActivity(agent, { kind: "pending", operation });
      try {
        await command();
        setActivity(agent, null);
      } catch (error) {
        setActivity(agent, {
          kind: "failed",
          operation,
          error: agentOperationError(error),
        });
      }
    },
    [setActivity],
  );

  /** Resolves to the saved agent, or to the error the form shows. */
  const save = useCallback(
    async (
      agent: string | null,
      definition: CustomAgentDefinitionDto,
    ): Promise<
      | { saved: CustomAgentSetupDto; error: null }
      | { saved: null; error: AgentOperationError }
    > => {
      try {
        const saved = agent
          ? await updateCustomAgent(agent, definition)
          : await addCustomAgent(definition);
        replace(saved);
        if (agent) setActivity(agent, null);
        return { saved, error: null };
      } catch (error) {
        return { saved: null, error: agentOperationError(error) };
      }
    },
    [replace, setActivity],
  );

  const remove = useCallback(
    (agent: string) =>
      run(agent, "remove_custom", async () => {
        await removeCustomAgent(agent);
        if (!mountedRef.current) return;
        setAgents(
          (current) =>
            current?.filter((candidate) => candidate.agent !== agent) ??
            current,
        );
      }),
    [run],
  );

  const setEnabled = useCallback(
    (agent: string, enabled: boolean) =>
      run(agent, enabled ? "enable" : "disable", async () =>
        replace(await setCustomAgentEnabled(agent, enabled)),
      ),
    [replace, run],
  );

  // What the agent declared is part of its facts, so they are read again.
  const check = useCallback(
    async (agent: string) => {
      setActivity(agent, { kind: "pending", operation: "check" });
      try {
        const result = await checkAgent(agent);
        await load();
        setActivity(
          agent,
          result.state === "unavailable" ? null : { kind: "checked", result },
        );
      } catch (error) {
        setActivity(agent, {
          kind: "failed",
          operation: "check",
          error: agentOperationError(error),
        });
      }
    },
    [load, setActivity],
  );

  const checkDraft = useCallback(
    (
      agent: string | null,
      definition: CustomAgentDefinitionDto,
    ): Promise<AgentCheckDto> => checkCustomAgentDraft(agent, definition),
    [],
  );

  // A refresh reads the facts again; earlier results no longer describe
  // them, while running operations keep going.
  const refresh = useCallback(async () => {
    setActivities((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([, activity]) => activity.kind === "pending",
        ),
      ),
    );
    await load();
  }, [load]);

  return {
    agents,
    activity: (agent: string): AgentRowActivity | null =>
      activities[agent] ?? null,
    refresh,
    save,
    remove,
    setEnabled,
    check,
    checkDraft,
  };
}

export type CustomAgents = ReturnType<typeof useCustomAgents>;
