import { useCallback, useMemo } from "react";
import { toast } from "sonner";

import type { ExternalOpenBinding } from "@/features/external-open";
import * as m from "@/paraglide/messages.js";
import { getNativeErrorMessage } from "@/platform/native/errors";

import {
  agentContextArtifactExternalOpenTarget,
  type ArtifactOpenTarget,
} from "../api/agent-context-api";

/** External open of an instruction or skill file, with failures as a toast. */
export function useAgentContextArtifactOpen({
  ownerRoot,
  canonicalArtifactPath,
}: ArtifactOpenTarget): ExternalOpenBinding {
  const target = useMemo(
    () =>
      agentContextArtifactExternalOpenTarget({
        canonicalArtifactPath,
        ownerRoot,
      }),
    [canonicalArtifactPath, ownerRoot],
  );
  const onError = useCallback(
    (error: unknown) => {
      console.error("Failed to open agent context file externally:", error);
      toast.error(
        m.agent_context_open_error({
          name: fileName(canonicalArtifactPath),
        }),
        { description: getNativeErrorMessage(error) },
      );
    },
    [canonicalArtifactPath],
  );

  return useMemo(() => ({ onError, target }), [onError, target]);
}

function fileName(path: string) {
  return path.replaceAll("\\", "/").split("/").at(-1) || path;
}
