export type UpdatePlatform = "darwin" | "windows" | "linux";

export interface DogfoodPlatformUpdate {
  url: string;
  fallbackUrl?: string;
  artifactName?: string;
}

export interface DogfoodFeedItemBase {
  version: string;
  commit: string;
  publishedAt: string;
  platforms: Partial<Record<UpdatePlatform, DogfoodPlatformUpdate>>;
}

export interface DogfoodStageReleaseItem extends DogfoodFeedItemBase {
  kind: "stage-release";
  notesUrl?: string;
}

export interface DogfoodCiBuildItem extends DogfoodFeedItemBase {
  kind: "ci-build";
  sourceRef?: string;
  runId?: number;
  expiresAt?: string;
  reason?: string;
}

export type DogfoodFeedItem = DogfoodStageReleaseItem | DogfoodCiBuildItem;

export interface DogfoodFeed {
  schema: 1;
  channel: "dogfood";
  items: DogfoodFeedItem[];
}

export interface AvailableDogfoodUpdate {
  item: DogfoodFeedItem;
  platform: UpdatePlatform;
  platformUpdate: DogfoodPlatformUpdate;
  id: string;
}

export interface CurrentBuildInfo {
  version: string;
  commit: string;
}

export function getCurrentUpdatePlatform(): UpdatePlatform {
  const platform = navigator.platform.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();

  if (platform.includes("mac") || userAgent.includes("mac os")) {
    return "darwin";
  }
  if (platform.includes("win") || userAgent.includes("windows")) {
    return "windows";
  }
  return "linux";
}

export function getBuildCommit(): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_SVODE_BUILD_COMMIT?.trim() ?? "";
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }

  return 0;
}

export function selectDogfoodUpdate(
  feed: DogfoodFeed,
  current: CurrentBuildInfo,
  platform: UpdatePlatform,
): AvailableDogfoodUpdate | null {
  const candidates = feed.items
    .map((item) => {
      const platformUpdate = item.platforms?.[platform];
      if (!platformUpdate?.url) return null;
      if (isExpired(item)) return null;

      if (item.kind === "stage-release") {
        if (compareVersions(item.version, current.version) <= 0) return null;
      } else {
        if (!current.commit || item.commit === current.commit) return null;
        if (compareVersions(item.version, current.version) < 0) return null;
      }

      return {
        item,
        platform,
        platformUpdate,
        id: dogfoodUpdateId(item, platform),
      };
    })
    .filter((item): item is AvailableDogfoodUpdate => Boolean(item));

  candidates.sort((a, b) => {
    const versionDiff = compareVersions(b.item.version, a.item.version);
    if (versionDiff !== 0) return versionDiff;

    const bTime = Date.parse(b.item.publishedAt) || 0;
    const aTime = Date.parse(a.item.publishedAt) || 0;
    return bTime - aTime;
  });

  return candidates[0] ?? null;
}

function parseVersion(version: string): number[] {
  return version
    .replace(/^v/i, "")
    .split(/[+-]/)[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function isExpired(item: DogfoodFeedItem): boolean {
  if (item.kind !== "ci-build" || !item.expiresAt) return false;
  const expiresAt = Date.parse(item.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function dogfoodUpdateId(
  item: DogfoodFeedItem,
  platform: UpdatePlatform,
): string {
  return [
    item.kind,
    item.version,
    item.commit,
    item.kind === "ci-build" ? (item.runId ?? "") : "",
    platform,
  ].join(":");
}
