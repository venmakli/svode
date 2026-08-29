import { invokeCommand } from "@/platform/native/invoke";

export type ArtifactSourceShapeDto = "file" | "directory";

export type AppMarkerProbeDto =
  | { status: "no_match" }
  | { status: "match" }
  | {
      status: "invalid";
      reason:
        | "duplicate"
        | "invalid_encoding"
        | "invalid_value"
        | "malformed"
        | "probe_limit";
    };

export function probeAppMarker(input: {
  spacePath: string;
  targetPath: string;
  sourceShape: ArtifactSourceShapeDto;
}): Promise<AppMarkerProbeDto> {
  return invokeCommand<AppMarkerProbeDto>("artifact_probe_app_marker", input);
}
