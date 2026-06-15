import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FEED_BRANCH = process.env.UPDATE_FEED_BRANCH || "update-feed";
const FEED_FILE = "dogfood.json";
const README_FILE = "README.md";
const PLATFORMS = ["darwin", "windows", "linux"];

function run(command, args, options = {}) {
  const output = execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  return typeof output === "string" ? output.trim() : "";
}

function tryRun(command, args, options = {}) {
  try {
    return { ok: true, output: run(command, args, options) };
  } catch (error) {
    return { ok: false, error };
  }
}

function env(name, fallback = "") {
  return process.env[name]?.trim() || fallback;
}

function requiredEnv(name) {
  const value = env(name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function nowIso() {
  return new Date().toISOString();
}

function loadFeed(feedDir) {
  try {
    const raw = readFileSync(join(feedDir, FEED_FILE), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items)) {
      throw new Error("dogfood.json has an invalid shape");
    }
    return parsed;
  } catch {
    return { schema: 1, channel: "dogfood", items: [] };
  }
}

function writeFeed(feedDir, feed) {
  const next = {
    schema: 1,
    channel: "dogfood",
    items: feed.items,
  };
  writeFileSync(join(feedDir, FEED_FILE), `${JSON.stringify(next, null, 2)}\n`);

  const readmePath = join(feedDir, README_FILE);
  try {
    readFileSync(readmePath, "utf8");
  } catch {
    writeFileSync(
      readmePath,
      [
        "# Svode update feed",
        "",
        "This branch stores public update metadata for dogfood builds.",
        "It intentionally does not contain application source code.",
        "",
      ].join("\n"),
    );
  }
}

function clearWorktreeFiles(feedDir) {
  for (const entry of readdirSync(feedDir)) {
    if (entry === ".git") continue;
    rmSync(join(feedDir, entry), { recursive: true, force: true });
  }
}

function remoteBranchExists() {
  return tryRun("git", [
    "ls-remote",
    "--exit-code",
    "--heads",
    "origin",
    FEED_BRANCH,
  ]).ok;
}

function prepareFeedWorktree(feedDir) {
  if (remoteBranchExists()) {
    run("git", ["fetch", "origin", FEED_BRANCH]);
    run("git", ["worktree", "add", "-B", FEED_BRANCH, feedDir, "FETCH_HEAD"]);
    return;
  }

  run("git", ["worktree", "add", "--detach", feedDir, "HEAD"]);
  run("git", ["-C", feedDir, "switch", "--orphan", FEED_BRANCH]);
  tryRun("git", ["-C", feedDir, "rm", "-rf", ".", "--ignore-unmatch"], {
    stdio: "ignore",
  });
  clearWorktreeFiles(feedDir);
}

function platformPayload() {
  const url = requiredEnv("UPDATE_URL");
  const payload = { url };
  const fallbackUrl = env("UPDATE_FALLBACK_URL");
  const artifactName = env("UPDATE_ARTIFACT_NAME");
  if (fallbackUrl) payload.fallbackUrl = fallbackUrl;
  if (artifactName) payload.artifactName = artifactName;
  return payload;
}

function removeEmpty(value) {
  if (Array.isArray(value)) return value.map(removeEmpty);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== "" && entryValue !== undefined)
      .map(([key, entryValue]) => [key, removeEmpty(entryValue)]),
  );
}

function updateStageRelease(feed) {
  const version = requiredEnv("UPDATE_VERSION").replace(/^v/, "");
  const commit = requiredEnv("UPDATE_COMMIT");
  const url = requiredEnv("UPDATE_URL");
  const publishedAt = env("UPDATE_PUBLISHED_AT", nowIso());
  const platforms = Object.fromEntries(
    PLATFORMS.map((platform) => [platform, { url }]),
  );
  const nextItem = removeEmpty({
    kind: "stage-release",
    version,
    commit,
    publishedAt,
    notesUrl: env("UPDATE_NOTES_URL", url),
    platforms,
  });

  feed.items = [
    nextItem,
    ...feed.items.filter(
      (item) => !(item.kind === "stage-release" && item.version === version),
    ),
  ];
}

function updateCiBuild(feed) {
  const version = requiredEnv("UPDATE_VERSION").replace(/^v/, "");
  const commit = requiredEnv("UPDATE_COMMIT");
  const runId = requiredEnv("UPDATE_RUN_ID");
  const platform = requiredEnv("UPDATE_PLATFORM");
  if (!PLATFORMS.includes(platform)) {
    throw new Error(`Unsupported UPDATE_PLATFORM: ${platform}`);
  }

  const existing = feed.items.find(
    (item) =>
      item.kind === "ci-build" &&
      item.commit === commit &&
      String(item.runId) === runId,
  );
  const base = existing ?? {
    kind: "ci-build",
    version,
    commit,
    sourceRef: env("UPDATE_SOURCE_REF"),
    runId: Number(runId),
    publishedAt: env("UPDATE_PUBLISHED_AT", nowIso()),
    expiresAt: env("UPDATE_EXPIRES_AT"),
    reason: env("UPDATE_REASON"),
    platforms: {},
  };

  base.version = version;
  base.sourceRef = env("UPDATE_SOURCE_REF", base.sourceRef ?? "");
  base.publishedAt = env("UPDATE_PUBLISHED_AT", base.publishedAt ?? nowIso());
  base.expiresAt = env("UPDATE_EXPIRES_AT", base.expiresAt ?? "");
  base.reason = env("UPDATE_REASON", base.reason ?? "");
  base.platforms = {
    ...(base.platforms ?? {}),
    [platform]: platformPayload(),
  };

  const nextItem = removeEmpty(base);
  feed.items = [
    nextItem,
    ...feed.items.filter(
      (item) =>
        !(
          item.kind === "ci-build" &&
          item.commit === commit &&
          String(item.runId) === runId
        ),
    ),
  ];
}

function pruneFeed(feed) {
  const now = Date.now();
  feed.items = feed.items
    .filter((item) => {
      if (item.kind !== "ci-build" || !item.expiresAt) return true;
      const expiresAt = Date.parse(item.expiresAt);
      return Number.isNaN(expiresAt) || expiresAt > now;
    })
    .sort((a, b) => {
      const bTime = Date.parse(b.publishedAt ?? "") || 0;
      const aTime = Date.parse(a.publishedAt ?? "") || 0;
      return bTime - aTime;
    })
    .slice(0, 30);
}

function applyFeedUpdate(feedDir) {
  const feed = loadFeed(feedDir);
  const kind = requiredEnv("UPDATE_KIND");

  if (kind === "stage-release") {
    updateStageRelease(feed);
  } else if (kind === "ci-build") {
    updateCiBuild(feed);
  } else {
    throw new Error(`Unsupported UPDATE_KIND: ${kind}`);
  }

  pruneFeed(feed);
  writeFeed(feedDir, feed);
}

function commitAndPush(feedDir) {
  run("git", ["-C", feedDir, "config", "user.name", "github-actions[bot]"]);
  run("git", [
    "-C",
    feedDir,
    "config",
    "user.email",
    "41898282+github-actions[bot]@users.noreply.github.com",
  ]);
  run("git", ["-C", feedDir, "add", FEED_FILE, README_FILE]);

  const diff = tryRun("git", ["-C", feedDir, "diff", "--cached", "--quiet"]);
  if (diff.ok) {
    console.log("Dogfood feed is already up to date.");
    return true;
  }

  const kind = requiredEnv("UPDATE_KIND");
  const version = env("UPDATE_VERSION");
  run(
    "git",
    ["-C", feedDir, "commit", "-m", `Update dogfood feed ${kind} ${version}`],
    {
      stdio: "inherit",
    },
  );
  run(
    "git",
    ["-C", feedDir, "push", "origin", `HEAD:refs/heads/${FEED_BRANCH}`],
    {
      stdio: "inherit",
    },
  );
  return true;
}

function cleanup(feedDir) {
  tryRun("git", ["worktree", "remove", "--force", feedDir], {
    stdio: "ignore",
  });
  rmSync(feedDir, { recursive: true, force: true });
}

const maxAttempts = 3;
for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const feedDir = mkdtempSync(join(tmpdir(), "svode-update-feed-"));
  try {
    prepareFeedWorktree(feedDir);
    applyFeedUpdate(feedDir);
    commitAndPush(feedDir);
    cleanup(feedDir);
    process.exit(0);
  } catch (error) {
    cleanup(feedDir);
    if (attempt === maxAttempts) {
      throw error;
    }
    console.warn(
      `Dogfood feed update attempt ${attempt} failed, retrying with fresh branch state.`,
    );
  }
}
