import type {
  ArtifactKind,
  ArtifactOpenTarget,
  ArtifactSourceShape,
} from "./types";

export interface ResolvedArtifactIdentity {
  kind: ArtifactKind;
  path: string;
  sourceShape: ArtifactSourceShape;
}

export type ArtifactAvailability = "ready" | "limited" | "unsupported";

export type ArtifactProbeResult =
  | { status: "no_match" }
  | {
      status: "match";
      identity: ResolvedArtifactIdentity;
      availability?: ArtifactAvailability;
    }
  | { status: "error"; reason: string };

export interface ArtifactAdapter<TSurface> {
  id: string;
  order: number;
  capabilities: Readonly<Record<string, boolean | string>>;
  probe: (
    target: ArtifactOpenTarget,
    signal: AbortSignal,
  ) => ArtifactProbeResult | Promise<ArtifactProbeResult>;
  surface?: TSurface;
}

export type ArtifactResolution<TSurface> =
  | {
      status: ArtifactAvailability;
      identity: ResolvedArtifactIdentity;
      adapter: ArtifactAdapter<TSurface>;
    }
  | { status: "no_match" }
  | { status: "cancelled" }
  | { status: "error"; adapterId: string; reason: string };

export class ArtifactRegistry<TSurface> {
  readonly adapters: readonly ArtifactAdapter<TSurface>[];

  constructor(adapters: readonly ArtifactAdapter<TSurface>[]) {
    const seenIds = new Set<string>();
    for (const adapter of adapters) {
      if (seenIds.has(adapter.id)) {
        throw new Error(`Duplicate artifact adapter: ${adapter.id}`);
      }
      seenIds.add(adapter.id);
    }
    this.adapters = [...adapters].sort(
      (left, right) =>
        left.order - right.order || left.id.localeCompare(right.id),
    );
  }

  async resolve(
    target: ArtifactOpenTarget,
    signal: AbortSignal,
  ): Promise<ArtifactResolution<TSurface>> {
    for (const adapter of this.adapters) {
      if (signal.aborted) return { status: "cancelled" };
      let probe: ArtifactProbeResult;
      try {
        probe = await adapter.probe(target, signal);
      } catch (error) {
        if (signal.aborted) return { status: "cancelled" };
        return {
          status: "error",
          adapterId: adapter.id,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (signal.aborted) return { status: "cancelled" };
      if (probe.status === "no_match") continue;
      if (probe.status === "error") {
        return {
          status: "error",
          adapterId: adapter.id,
          reason: probe.reason,
        };
      }
      return {
        status: probe.availability ?? "ready",
        identity: probe.identity,
        adapter,
      };
    }
    return { status: "no_match" };
  }
}

export type LatestArtifactResolution<TSurface> =
  | { status: "current"; resolution: ArtifactResolution<TSurface> }
  | { status: "stale" };

export class ArtifactResolutionSession {
  private marker = 0;

  async resolve<TSurface>(
    registry: ArtifactRegistry<TSurface>,
    target: ArtifactOpenTarget,
    signal: AbortSignal,
  ): Promise<LatestArtifactResolution<TSurface>> {
    const requestMarker = ++this.marker;
    const resolution = await registry.resolve(target, signal);
    return requestMarker === this.marker
      ? { status: "current", resolution }
      : { status: "stale" };
  }

  invalidate() {
    this.marker += 1;
  }
}
