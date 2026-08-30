import type { ArtifactSurfaceContribution } from "@/features/artifact";
import type { RepositoryAccessStatus } from "@/features/git";

export type PageSurfaceMode = "edit" | "view";

export function pageDefaultMode(
  status: RepositoryAccessStatus | null | undefined,
): PageSurfaceMode {
  return status === "local" || status === "writable" ? "edit" : "view";
}

export function createPageSurfaceContributions({
  editLabel,
  mode,
  status,
  viewLabel,
}: {
  editLabel: string;
  mode: PageSurfaceMode | null;
  status: RepositoryAccessStatus | null | undefined;
  viewLabel: string;
}): ArtifactSurfaceContribution[] {
  const defaultMode = pageDefaultMode(status);
  const canWrite = defaultMode === "edit";
  return [
    {
      id: "edit",
      label: editLabel,
      role: "edit",
      availability: canWrite ? "available" : "recoverable",
      isDefault: mode ? mode === "edit" : defaultMode === "edit",
    },
    {
      id: "view",
      label: viewLabel,
      role: "view",
      availability: "available",
      isDefault: mode ? mode === "view" : defaultMode === "view",
    },
  ];
}
