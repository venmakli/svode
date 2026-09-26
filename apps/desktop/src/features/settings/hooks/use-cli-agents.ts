import { useCallback, useEffect, useState } from "react";
import { listAvailableAgents } from "../api";
import type { AvailableAgent } from "../model";

export function useCliAgents() {
  const [agents, setAgents] = useState<AvailableAgent[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const loadAgents = useCallback(async () => {
    try {
      const list = await listAvailableAgents();
      setAgents(list);
    } catch (err) {
      console.error("Failed to load agents:", err);
    }
  }, []);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  const refreshAgents = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadAgents();
    } finally {
      setRefreshing(false);
    }
  }, [loadAgents]);

  return {
    agents,
    refreshing,
    refreshAgents,
  };
}
