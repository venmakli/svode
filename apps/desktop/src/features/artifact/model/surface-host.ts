export type ArtifactSurfaceAvailability =
  | "available"
  | "recoverable"
  | "unavailable";

export type ArtifactSurfaceRole = "edit" | "view" | "run" | "viewer";

export interface ArtifactSurfaceContribution {
  id: string;
  label: string;
  role: ArtifactSurfaceRole;
  availability: ArtifactSurfaceAvailability;
  isDefault: boolean;
}

export interface ResolvedArtifactSurfaceHost {
  contributions: readonly ArtifactSurfaceContribution[];
  currentId: string;
  defaultId: string;
}

export function resolveArtifactSurfaceHost(
  contributions: readonly ArtifactSurfaceContribution[],
  currentId?: string | null,
): ResolvedArtifactSurfaceHost {
  const ids = new Set<string>();
  for (const contribution of contributions) {
    if (ids.has(contribution.id)) {
      throw new Error(`Duplicate artifact surface: ${contribution.id}`);
    }
    ids.add(contribution.id);
  }

  const offered = contributions.filter(
    ({ availability }) => availability !== "unavailable",
  );
  const defaults = offered.filter(({ isDefault }) => isDefault);
  if (defaults.length !== 1) {
    throw new Error(
      `Artifact surface host requires one offered default; received ${defaults.length}`,
    );
  }

  const defaultId = defaults[0].id;
  return {
    contributions: offered,
    currentId: offered.some(({ id }) => id === currentId)
      ? (currentId as string)
      : defaultId,
    defaultId,
  };
}

export type ArtifactSurfaceTransitionStep = "ready" | "blocked";

export type ArtifactSurfaceTransitionResult =
  | { status: "activated" }
  | { status: "blocked" }
  | { status: "stale" }
  | { status: "error"; error: unknown };

export class ArtifactSurfaceTransitionSession {
  private marker = 0;

  async transition({
    activate,
    deactivate,
  }: {
    activate?: () =>
      | ArtifactSurfaceTransitionStep
      | Promise<ArtifactSurfaceTransitionStep>;
    deactivate?: () =>
      | ArtifactSurfaceTransitionStep
      | Promise<ArtifactSurfaceTransitionStep>;
  }): Promise<ArtifactSurfaceTransitionResult> {
    const requestMarker = ++this.marker;
    try {
      if (deactivate && (await deactivate()) === "blocked") {
        return requestMarker === this.marker
          ? { status: "blocked" }
          : { status: "stale" };
      }
      if (requestMarker !== this.marker) return { status: "stale" };
      if (activate && (await activate()) === "blocked") {
        return requestMarker === this.marker
          ? { status: "blocked" }
          : { status: "stale" };
      }
      return requestMarker === this.marker
        ? { status: "activated" }
        : { status: "stale" };
    } catch (error) {
      return requestMarker === this.marker
        ? { status: "error", error }
        : { status: "stale" };
    }
  }

  invalidate() {
    this.marker += 1;
  }
}
