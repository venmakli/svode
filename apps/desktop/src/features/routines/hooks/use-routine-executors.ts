import { useEffect, useState } from "react";

import {
  listAgentActorOptions,
  type AgentActorOption,
} from "@/features/actors";

export function useRoutineExecutors(
  projectPath: string,
  launchSpacePath: string,
) {
  const sourceKey = JSON.stringify([projectPath, launchSpacePath]);
  const [snapshot, setSnapshot] = useState<{
    error: string | null;
    options: readonly AgentActorOption[];
    sourceKey: string;
  }>({ error: null, options: [], sourceKey: "" });

  useEffect(() => {
    let cancelled = false;
    void listAgentActorOptions(projectPath, launchSpacePath).then(
      (nextOptions) => {
        if (!cancelled) {
          setSnapshot({ error: null, options: nextOptions, sourceKey });
        }
      },
      (reason: unknown) => {
        if (cancelled) return;
        setSnapshot({
          error:
            reason instanceof Error && reason.message
              ? reason.message
              : String(reason),
          options: [],
          sourceKey,
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [launchSpacePath, projectPath, sourceKey]);

  return snapshot.sourceKey === sourceKey
    ? { error: snapshot.error, options: snapshot.options }
    : { error: null, options: [] };
}
