import { useCallback, useEffect, useRef, useState } from "react";
import { repairKnowledgeSnapshot } from "../api/knowledge-api";

interface KnowledgeRepairState {
  projectPath: string | null;
  repairing: boolean;
  repairError: string | null;
}

export function useKnowledgeRepair(
  projectPath: string | null,
  onRepaired: () => void,
) {
  const [state, setState] = useState<KnowledgeRepairState>({
    projectPath,
    repairing: false,
    repairError: null,
  });
  const requestId = useRef(0);

  useEffect(() => {
    requestId.current += 1;
    return () => {
      requestId.current += 1;
    };
  }, [projectPath]);

  const repair = useCallback(async () => {
    if (!projectPath) return;

    const currentRequest = ++requestId.current;
    setState({ projectPath, repairing: true, repairError: null });
    try {
      await repairKnowledgeSnapshot(projectPath);
      if (currentRequest !== requestId.current) return;
      setState({ projectPath, repairing: false, repairError: null });
      onRepaired();
    } catch {
      if (currentRequest !== requestId.current) return;
      setState({
        projectPath,
        repairing: false,
        repairError: "repair_failed",
      });
    }
  }, [onRepaired, projectPath]);

  const currentState =
    state.projectPath === projectPath
      ? state
      : { projectPath, repairing: false, repairError: null };

  return {
    repair,
    repairing: currentState.repairing,
    repairError: currentState.repairError,
  };
}
