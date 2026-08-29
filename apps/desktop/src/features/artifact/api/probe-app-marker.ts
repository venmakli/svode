import { probeAppMarker } from "@/platform/artifact/artifact-api";
import type { ArtifactOpenTarget } from "../model/types";
import type { ArtifactProbeResult } from "../model/registry";

export async function probeMarkedApp(
  target: ArtifactOpenTarget,
  spacePath: string,
): Promise<ArtifactProbeResult> {
  if (target.sourceShape !== "directory") return { status: "no_match" };
  const result = await probeAppMarker({
    spacePath,
    targetPath: target.path,
    sourceShape: target.sourceShape,
  });
  if (result.status === "no_match") return result;
  if (result.status === "invalid") {
    return { status: "error", reason: `invalid_app_marker:${result.reason}` };
  }
  return {
    status: "match",
    availability: "unsupported",
    identity: {
      kind: "app",
      path: target.path,
      sourceShape: target.sourceShape,
    },
  };
}
