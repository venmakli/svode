import { useEffect, useState } from "react";

import {
  listAgentActorOptions,
  type AgentActorOption,
} from "@/features/actors";

export function useRoutineExecutors(
  projectPath: string,
  launchSpacePath: string,
  enabled = true,
) {
  const [request, setRequest] = useState(0);
  const ownerKey = JSON.stringify([projectPath, launchSpacePath]);
  const requestKey = JSON.stringify([projectPath, launchSpacePath, request]);
  const [snapshot, setSnapshot] = useState<{
    error: string | null;
    loading: boolean;
    ownerKey: string;
    options: readonly AgentActorOption[];
    requestKey: string;
  }>({ error: null, loading: true, ownerKey: "", options: [], requestKey: "" });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void listAgentActorOptions(projectPath, launchSpacePath).then(
      (nextOptions) => {
        if (!cancelled) {
          setSnapshot({
            error: null,
            loading: false,
            ownerKey,
            options: nextOptions,
            requestKey,
          });
        }
      },
      (reason: unknown) => {
        if (cancelled) return;
        setSnapshot({
          error:
            reason instanceof Error && reason.message
              ? reason.message
              : String(reason),
          loading: false,
          ownerKey,
          options: [],
          requestKey,
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, launchSpacePath, ownerKey, projectPath, requestKey]);

  if (!enabled) {
    return {
      error: null,
      loading: false,
      options: [] as readonly AgentActorOption[],
      retry: () => setRequest((current) => current + 1),
    };
  }

  return snapshot.requestKey === requestKey
    ? {
        error: snapshot.error,
        loading: snapshot.loading,
        options: snapshot.options,
        retry: () => setRequest((current) => current + 1),
      }
    : {
        error: null,
        loading: true,
        options: snapshot.ownerKey === ownerKey ? snapshot.options : [],
        retry: () => setRequest((current) => current + 1),
      };
}
