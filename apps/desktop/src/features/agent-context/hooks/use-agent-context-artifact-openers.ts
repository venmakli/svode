import { useEffect, useState } from "react";

import {
  listAgentContextArtifactOpeners,
  type ArtifactOpener,
} from "../api/agent-context-api";

export function useAgentContextArtifactOpeners(): readonly ArtifactOpener[] {
  const [openers, setOpeners] = useState<readonly ArtifactOpener[]>([]);

  useEffect(() => {
    let cancelled = false;
    void listAgentContextArtifactOpeners().then(
      (nextOpeners) => {
        if (!cancelled) setOpeners(nextOpeners);
      },
      () => {
        if (!cancelled) setOpeners([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return openers;
}
