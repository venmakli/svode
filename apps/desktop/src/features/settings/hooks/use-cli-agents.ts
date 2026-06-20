import { useCallback, useEffect, useState } from "react";
import { listAvailableAgents } from "../api";
import type { AvailableAgent } from "../model";

interface UseCliAgentsOptions {
  open: boolean;
  enabled: boolean;
}

export function useCliAgents({ open, enabled }: UseCliAgentsOptions) {
  const [agents, setAgents] = useState<AvailableAgent[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const loadAgents = useCallback(async () => {
    if (!enabled) {
      setAgents([]);
      return;
    }

    try {
      const list = await listAvailableAgents();
      setAgents(list);
    } catch (err) {
      console.error("Failed to load agents:", err);
    }
  }, [enabled]);

  useEffect(() => {
    if (!open || !enabled) return;
    loadAgents();
  }, [open, enabled, loadAgents]);

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
