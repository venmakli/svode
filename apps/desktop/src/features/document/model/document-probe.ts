import type { ArtifactOpenTarget } from "@/features/artifact";

import { documentFormatFromPath } from "./types";

export function probeDocumentTarget(target: ArtifactOpenTarget) {
  if (target.sourceShape !== "file" || !documentFormatFromPath(target.path)) {
    return { status: "no_match" as const };
  }
  return {
    status: "match" as const,
    availability: "ready" as const,
    identity: {
      kind: "document" as const,
      path: target.path,
      sourceShape: target.sourceShape,
    },
  };
}
