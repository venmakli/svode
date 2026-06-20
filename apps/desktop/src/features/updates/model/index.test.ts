import {
  compareVersions,
  selectDogfoodUpdate,
  type DogfoodFeed,
  type DogfoodFeedItem,
} from "./index";

const NOW = Date.parse("2026-06-20T00:00:00.000Z");

run("compareVersions handles v-prefixes and build metadata", () => {
  assert(compareVersions("v0.0.6", "0.0.5") > 0, "newer version should win");
  assert(compareVersions("1.2.3+5", "1.2.3") === 0, "build metadata ignored");
  assert(compareVersions("1.2.3", "1.2.10") < 0, "numeric parts compare");
});

run("selectDogfoodUpdate chooses the newest stage release for the platform", () => {
  const selected = selectDogfoodUpdate(
    feed([
      stageRelease("0.0.7", "older", "2026-06-17T00:00:00.000Z"),
      stageRelease("0.0.8", "newer", "2026-06-18T00:00:00.000Z"),
      {
        ...stageRelease("0.0.9", "wrong-platform", "2026-06-19T00:00:00.000Z"),
        platforms: { linux: { url: "https://example.test/linux.dmg" } },
      },
    ]),
    { version: "0.0.5", commit: "current" },
    "darwin",
    NOW,
  );

  assert(selected !== null, "newest compatible release wins");
  assert(selected.item.version === "0.0.8", "newest compatible release wins");
  assert(selected.id === "stage-release:0.0.8:newer::darwin", "id is stable");
});

run("selectDogfoodUpdate ignores current, expired, and same-commit builds", () => {
  const selected = selectDogfoodUpdate(
    feed([
      stageRelease("0.0.5", "same-version", "2026-06-18T00:00:00.000Z"),
      ciBuild("0.0.6", "current", "2026-06-19T00:00:00.000Z", {
        runId: 100,
      }),
      ciBuild("0.0.7", "expired", "2026-06-19T00:00:00.000Z", {
        expiresAt: "2026-06-19T23:59:59.000Z",
        runId: 101,
      }),
    ]),
    { version: "0.0.5", commit: "current" },
    "darwin",
    NOW,
  );

  assert(selected === null, "no eligible update should be selected");
});

run("selectDogfoodUpdate allows same-version CI builds with a new commit", () => {
  const selected = selectDogfoodUpdate(
    feed([
      ciBuild("0.0.5", "new-commit", "2026-06-19T00:00:00.000Z", {
        expiresAt: "2026-06-21T00:00:00.000Z",
        runId: 42,
      }),
    ]),
    { version: "0.0.5", commit: "current" },
    "darwin",
    NOW,
  );

  assert(selected !== null, "CI build should be selected");
  assert(selected.item.kind === "ci-build", "CI build should be selected");
  assert(selected.id === "ci-build:0.0.5:new-commit:42:darwin", "id includes run id");
});

function run(name: string, test: () => void) {
  test();
  console.log(`ok - ${name}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function feed(items: DogfoodFeedItem[]): DogfoodFeed {
  return {
    schema: 1,
    channel: "dogfood",
    items,
  };
}

function stageRelease(
  version: string,
  commit: string,
  publishedAt: string,
): DogfoodFeedItem {
  return {
    kind: "stage-release",
    version,
    commit,
    publishedAt,
    platforms: {
      darwin: { url: `https://example.test/${commit}.dmg` },
    },
  };
}

function ciBuild(
  version: string,
  commit: string,
  publishedAt: string,
  options: { expiresAt?: string; runId?: number } = {},
): DogfoodFeedItem {
  return {
    kind: "ci-build",
    version,
    commit,
    publishedAt,
    expiresAt: options.expiresAt,
    runId: options.runId,
    platforms: {
      darwin: { url: `https://example.test/${commit}.dmg` },
    },
  };
}
