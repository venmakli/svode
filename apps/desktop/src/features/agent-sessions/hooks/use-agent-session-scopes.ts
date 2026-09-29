import { useMemo } from "react";
import { useSpace } from "@/features/space";
import { buildAgentSessionScopes, type AgentSessionScopeGroup } from "../model";

/** The Spaces sessions can belong to: the project root and registered Spaces. */
export function useAgentSessionScopes(): AgentSessionScopeGroup[] {
  const activeRootIcon = useSpace((state) => state.activeRootIcon);
  const activeRootId = useSpace((state) => state.activeRootId);
  const activeRootName = useSpace((state) => state.activeRootName);
  const activeRootPath = useSpace((state) => state.activeRootPath);
  const spaces = useSpace((state) => state.spaces);
  return useMemo(
    () =>
      buildAgentSessionScopes({
        activeRootIcon,
        activeRootId,
        activeRootName,
        activeRootPath,
        spaces,
      }),
    [activeRootIcon, activeRootId, activeRootName, activeRootPath, spaces],
  );
}
