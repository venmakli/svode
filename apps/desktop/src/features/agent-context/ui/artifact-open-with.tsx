import { ExternalOpenButton } from "@/features/external-open";

import type { ArtifactOpenTarget } from "../api/agent-context-api";
import { useAgentContextArtifactOpen } from "../hooks/use-agent-context-artifact-open";

/** "Open with" for the file of an instruction or skill. */
export function AgentContextArtifactOpenWith(target: ArtifactOpenTarget) {
  return <ExternalOpenButton {...useAgentContextArtifactOpen(target)} />;
}
