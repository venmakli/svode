import type {
  DogfoodCiBuildItem,
  DogfoodFeed,
  DogfoodFeedItem,
  DogfoodPlatformUpdate,
  DogfoodStageReleaseItem,
  UpdatePlatform,
} from "../model";

export const DOGFOOD_FEED_URL =
  "https://raw.githubusercontent.com/venmakli/svode/update-feed/dogfood.json";

const UPDATE_PLATFORMS = ["darwin", "windows", "linux"] as const;

export async function fetchDogfoodFeed(
  signal?: AbortSignal,
): Promise<DogfoodFeed> {
  const response = await fetch(`${DOGFOOD_FEED_URL}?t=${Date.now()}`, {
    cache: "no-store",
    signal,
  });

  if (!response.ok) {
    throw new Error(`Dogfood feed request failed: ${response.status}`);
  }

  return parseDogfoodFeed(await response.json());
}

export function parseDogfoodFeed(payload: unknown): DogfoodFeed {
  if (
    !isRecord(payload) ||
    payload.schema !== 1 ||
    payload.channel !== "dogfood" ||
    !Array.isArray(payload.items)
  ) {
    throw new Error("Dogfood feed has an unsupported format");
  }

  return {
    schema: 1,
    channel: "dogfood",
    items: payload.items.map(parseDogfoodFeedItem),
  };
}

function parseDogfoodFeedItem(item: unknown): DogfoodFeedItem {
  if (
    !isRecord(item) ||
    (item.kind !== "stage-release" && item.kind !== "ci-build")
  ) {
    throw new Error("Dogfood feed has an unsupported format");
  }

  const version = requiredString(item.version, "version");
  const commit = requiredString(item.commit, "commit");
  const publishedAt = requiredDateString(item.publishedAt, "publishedAt");
  const platforms = parsePlatforms(item.platforms);

  if (item.kind === "stage-release") {
    const parsed: DogfoodStageReleaseItem = {
      kind: item.kind,
      version,
      commit,
      publishedAt,
      platforms,
    };
    const notesUrl = optionalString(item.notesUrl, "notesUrl");
    if (notesUrl !== undefined) parsed.notesUrl = notesUrl;
    return parsed;
  }

  const parsed: DogfoodCiBuildItem = {
    kind: item.kind,
    version,
    commit,
    publishedAt,
    platforms,
  };
  const sourceRef = optionalString(item.sourceRef, "sourceRef");
  const expiresAt = optionalDateString(item.expiresAt, "expiresAt");
  const reason = optionalString(item.reason, "reason");
  const runId = optionalInteger(item.runId, "runId");
  if (sourceRef !== undefined) parsed.sourceRef = sourceRef;
  if (expiresAt !== undefined) parsed.expiresAt = expiresAt;
  if (reason !== undefined) parsed.reason = reason;
  if (runId !== undefined) parsed.runId = runId;
  return parsed;
}

function parsePlatforms(
  value: unknown,
): Partial<Record<UpdatePlatform, DogfoodPlatformUpdate>> {
  if (!isRecord(value)) {
    throw new Error("Dogfood feed has invalid platforms");
  }

  const platforms: Partial<Record<UpdatePlatform, DogfoodPlatformUpdate>> = {};
  for (const platform of UPDATE_PLATFORMS) {
    const update = value[platform];
    if (update === undefined) continue;
    platforms[platform] = parsePlatformUpdate(update, platform);
  }
  return platforms;
}

function parsePlatformUpdate(
  value: unknown,
  platform: UpdatePlatform,
): DogfoodPlatformUpdate {
  if (!isRecord(value)) {
    throw new Error(`Dogfood feed has invalid ${platform} update`);
  }

  const parsed: DogfoodPlatformUpdate = {
    url: requiredString(value.url, `${platform}.url`),
  };
  const fallbackUrl = optionalString(
    value.fallbackUrl,
    `${platform}.fallbackUrl`,
  );
  const artifactName = optionalString(
    value.artifactName,
    `${platform}.artifactName`,
  );
  if (fallbackUrl !== undefined) parsed.fallbackUrl = fallbackUrl;
  if (artifactName !== undefined) parsed.artifactName = artifactName;
  return parsed;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Dogfood feed has invalid ${field}`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field);
}

function requiredDateString(value: unknown, field: string): string {
  const date = requiredString(value, field);
  if (!Number.isFinite(Date.parse(date))) {
    throw new Error(`Dogfood feed has invalid ${field}`);
  }
  return date;
}

function optionalDateString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredDateString(value, field);
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Dogfood feed has invalid ${field}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
