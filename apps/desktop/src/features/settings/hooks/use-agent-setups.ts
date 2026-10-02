import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkAgent,
  disableAgent,
  enableAgent,
  listAgentSetups,
  removeAgentAdapter,
  signInAgent,
  updateAgentAdapter,
  type AgentSetupDto,
} from "../api";
import {
  agentOperationError,
  enableInstallsAdapter,
  type AgentOperation,
  type AgentRowActivity,
} from "../model/agent-row";

type Activities = Readonly<Record<string, AgentRowActivity>>;

/**
 * Setup facts of every registry agent and what the user does with them.
 * Reading the facts starts no agent process and installs nothing; each
 * operation changes only its own agent's row.
 */
export function useAgentSetups() {
  const [setups, setSetups] = useState<AgentSetupDto[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
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
      const next = await listAgentSetups();
      if (!mountedRef.current || generation !== loadGenerationRef.current)
        return;
      setSetups(next);
      setLoadFailed(false);
    } catch (error) {
      console.error("Failed to read agent setup:", error);
      if (!mountedRef.current || generation !== loadGenerationRef.current)
        return;
      setSetups((current) => current ?? []);
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A refresh reads the facts again; results of earlier checks and failed
  // operations no longer describe them, while running operations keep going.
  const refresh = useCallback(async () => {
    setRefreshing(true);
    setActivities((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([, activity]) => activity.kind === "pending",
        ),
      ),
    );
    try {
      await load();
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  }, [load]);

  const run = useCallback(
    async (
      agent: string,
      operation: AgentOperation,
      command: (agent: string) => Promise<AgentSetupDto>,
    ) => {
      setActivity(agent, { kind: "pending", operation });
      try {
        const next = await command(agent);
        if (!mountedRef.current) return;
        setSetups(
          (current) =>
            current?.map((setup) => (setup.agent === agent ? next : setup)) ??
            current,
        );
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

  const setEnabled = useCallback(
    (setup: AgentSetupDto, enabled: boolean) => {
      if (!enabled) return run(setup.agent, "disable", disableAgent);
      return run(
        setup.agent,
        enableInstallsAdapter(setup) ? "install" : "enable",
        enableAgent,
      );
    },
    [run],
  );

  const updateAdapter = useCallback(
    (agent: string) => run(agent, "update", updateAgentAdapter),
    [run],
  );

  const removeAdapter = useCallback(
    (agent: string) => run(agent, "remove", removeAgentAdapter),
    [run],
  );

  const check = useCallback(
    async (agent: string) => {
      setActivity(agent, { kind: "pending", operation: "check" });
      try {
        const result = await checkAgent(agent);
        if (result.state === "unavailable") {
          // The facts say why; read them again instead of a second copy.
          setActivity(agent, null);
          await load();
          return;
        }
        setActivity(agent, { kind: "checked", result });
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

  /** Opens the agent's sign-in terminal; resolves to its pty id. */
  const signIn = useCallback(
    async (agent: string) => {
      setActivity(agent, null);
      try {
        return (await signInAgent(agent)).ptyId;
      } catch (error) {
        setActivity(agent, {
          kind: "failed",
          operation: "sign_in",
          error: agentOperationError(error),
        });
        return null;
      }
    },
    [setActivity],
  );

  return {
    setups,
    loadFailed,
    refreshing,
    activity: (agent: string): AgentRowActivity | null =>
      activities[agent] ?? null,
    refresh,
    reload: load,
    setEnabled,
    updateAdapter,
    removeAdapter,
    check,
    signIn,
  };
}

export type AgentSetups = ReturnType<typeof useAgentSetups>;
