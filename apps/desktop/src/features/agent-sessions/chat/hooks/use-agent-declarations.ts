import { useEffect, useState } from "react";
import { lastAgentDeclarations } from "../api/chat";
import type { AgentDeclaration } from "../model/declared-settings";

/**
 * What `agent` declared last on this device, per model, the latest first
 * (Stage 11 `03`): the settings a draft shows without a draft session whose
 * values change. Null while they load; none when they cannot be read.
 */
export function useLastAgentDeclarations(
  agent: string | null,
  enabled: boolean,
): AgentDeclaration[] | null {
  const [result, setResult] = useState<{
    agent: string;
    declarations: AgentDeclaration[];
  } | null>(null);
  useEffect(() => {
    if (!agent || !enabled) return;
    let current = true;
    lastAgentDeclarations(agent)
      .catch(() => [])
      .then((declarations) => {
        if (current) setResult({ agent, declarations });
      });
    return () => {
      current = false;
    };
  }, [agent, enabled]);
  if (!agent || !enabled) return [];
  return result?.agent === agent ? result.declarations : null;
}
