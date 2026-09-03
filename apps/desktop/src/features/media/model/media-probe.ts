import type { ArtifactOpenTarget } from "@/features/artifact";

import { mediaFormatFromPath } from "./types";

export function probeMediaTarget(target: ArtifactOpenTarget) {
  if (target.sourceShape !== "file" || !mediaFormatFromPath(target.path)) {
    return { status: "no_match" as const };
  }
  return {
    status: "match" as const,
    availability: "ready" as const,
    identity: {
      kind: "media" as const,
      path: target.path,
      sourceShape: target.sourceShape,
    },
  };
}
