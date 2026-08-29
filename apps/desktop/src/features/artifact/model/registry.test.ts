import { expect, test } from "bun:test";
import {
  ArtifactRegistry,
  ArtifactResolutionSession,
  type ArtifactAdapter,
} from "./registry";
import type { ArtifactOpenTarget } from "./types";

type Surface = () => null;

const target: ArtifactOpenTarget = {
  spaceId: "root",
  path: "dashboard/README.md",
  sourceShape: "directory",
  semanticHint: { kind: "page" },
};

function adapter(
  id: string,
  order: number,
  probe: ArtifactAdapter<Surface>["probe"],
): ArtifactAdapter<Surface> {
  return { id, order, capabilities: {}, probe };
}

test("uses deterministic priority instead of registration order", async () => {
  const visited: string[] = [];
  const page = adapter("page", 200, () => {
    visited.push("page");
    return {
      status: "match",
      identity: { kind: "page", path: target.path, sourceShape: "directory" },
    };
  });
  const app = adapter("app", 100, () => {
    visited.push("app");
    return {
      status: "match",
      identity: { kind: "app", path: target.path, sourceShape: "directory" },
    };
  });
  const registry = new ArtifactRegistry([page, app]);

  const result = await registry.resolve(target, new AbortController().signal);

  expect(visited).toEqual(["app"]);
  expect(result.status === "ready" ? result.identity.kind : null).toBe("app");
});

test("invalid marker and probe failures stop Page fallback", async () => {
  let pageProbes = 0;
  const page = adapter("page", 200, () => {
    pageProbes += 1;
    return {
      status: "match",
      identity: { kind: "page", path: target.path, sourceShape: "directory" },
    };
  });
  const invalid = new ArtifactRegistry([
    adapter("app", 100, () => ({ status: "error", reason: "invalid marker" })),
    page,
  ]);
  const crashed = new ArtifactRegistry([
    adapter("app", 100, () => {
      throw new Error("probe failed");
    }),
    page,
  ]);

  expect(await invalid.resolve(target, new AbortController().signal)).toEqual({
    status: "error",
    adapterId: "app",
    reason: "invalid marker",
  });
  expect(await crashed.resolve(target, new AbortController().signal)).toEqual({
    status: "error",
    adapterId: "app",
    reason: "probe failed",
  });
  expect(pageProbes).toBe(0);
});

test("reports duplicate adapter identity and honest no-match", async () => {
  let duplicateError = "";
  try {
    new ArtifactRegistry([
      adapter("page", 100, () => ({ status: "no_match" })),
      adapter("page", 200, () => ({ status: "no_match" })),
    ]);
  } catch (error) {
    duplicateError = error instanceof Error ? error.message : String(error);
  }
  expect(duplicateError).toBe("Duplicate artifact adapter: page");

  const registry = new ArtifactRegistry([
    adapter("page", 100, () => ({ status: "no_match" })),
  ]);
  expect(await registry.resolve(target, new AbortController().signal)).toEqual({
    status: "no_match",
  });
});

test("request marker rejects a late result from the previous selection", async () => {
  const resolvers: Array<() => void> = [];
  const registry = new ArtifactRegistry([
    adapter("page", 100, async (candidate) => {
      await new Promise<void>((resolve) => resolvers.push(resolve));
      return {
        status: "match",
        identity: {
          kind: "page",
          path: candidate.path,
          sourceShape: candidate.sourceShape,
        },
      };
    }),
  ]);
  const session = new ArtifactResolutionSession();
  const first = session.resolve(
    registry,
    { ...target, path: "first/README.md" },
    new AbortController().signal,
  );
  const second = session.resolve(
    registry,
    { ...target, path: "second/README.md" },
    new AbortController().signal,
  );

  resolvers[1]?.();
  const secondResult = await second;
  resolvers[0]?.();
  const firstResult = await first;

  expect(secondResult).toEqual({
    status: "current",
    resolution: {
      status: "ready",
      identity: {
        kind: "page",
        path: "second/README.md",
        sourceShape: "directory",
      },
      adapter: registry.adapters[0],
    },
  });
  expect(firstResult).toEqual({ status: "stale" });
});
