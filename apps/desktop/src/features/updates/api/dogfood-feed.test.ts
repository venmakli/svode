import { parseDogfoodFeed } from "./dogfood-feed";

run("parseDogfoodFeed validates and normalizes feed items", () => {
  const feed = parseDogfoodFeed({
    schema: 1,
    channel: "dogfood",
    items: [
      {
        kind: "ci-build",
        version: " 0.0.6 ",
        commit: "abc123",
        publishedAt: "2026-06-20T00:00:00.000Z",
        sourceRef: "main",
        runId: 42,
        expiresAt: "2026-06-21T00:00:00.000Z",
        reason: "smoke build",
        platforms: {
          darwin: {
            url: " https://example.test/svode.dmg ",
            fallbackUrl: "https://example.test/releases",
            artifactName: "svode.dmg",
          },
          ios: {
            url: "https://example.test/ignored.ipa",
          },
        },
      },
    ],
  });

  const item = feed.items[0];
  assert(item?.kind === "ci-build", "CI build should be parsed");
  assert(item.version === "0.0.6", "version should be trimmed");
  assert(item.runId === 42, "run id should be preserved");
  assert(
    item.platforms.darwin?.url === "https://example.test/svode.dmg",
    "platform URL should be trimmed",
  );
  assert(
    item.platforms.linux === undefined,
    "missing platform should remain absent",
  );
});

run("parseDogfoodFeed rejects invalid platform updates", () => {
  assertThrows(() =>
    parseDogfoodFeed({
      schema: 1,
      channel: "dogfood",
      items: [
        {
          kind: "stage-release",
          version: "0.0.6",
          commit: "abc123",
          publishedAt: "2026-06-20T00:00:00.000Z",
          platforms: {
            darwin: {
              fallbackUrl: "https://example.test/releases",
            },
          },
        },
      ],
    }),
  );
});

run("parseDogfoodFeed rejects invalid dates", () => {
  assertThrows(() =>
    parseDogfoodFeed({
      schema: 1,
      channel: "dogfood",
      items: [
        {
          kind: "ci-build",
          version: "0.0.6",
          commit: "abc123",
          publishedAt: "not-a-date",
          platforms: {
            darwin: {
              url: "https://example.test/svode.dmg",
            },
          },
        },
      ],
    }),
  );
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

function assertThrows(test: () => void) {
  try {
    test();
  } catch {
    return;
  }
  throw new Error("expected function to throw");
}
