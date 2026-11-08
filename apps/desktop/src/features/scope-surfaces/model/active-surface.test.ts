import { expect, test } from "bun:test";
import type { ScopeSurfaceContribution } from "./types";
import {
  resolveActiveScopeSurface,
  resolveDefaultScopeSurface,
} from "./active-surface";
import {
  createCollectionDirectoryOwner,
  createAppDirectoryOwner,
  createPageOwner,
  createRegisteredSpaceOwner,
} from "./owners";

const surfaces = [
  { id: "readme" },
  { id: "pages" },
] as ScopeSurfaceContribution[];

test("uses the requested available scope surface", () => {
  expect(resolveActiveScopeSurface(surfaces, "pages")?.id).toBe("pages");
});

test("falls back to the first available scope surface", () => {
  expect(resolveActiveScopeSurface(surfaces, "context")?.id).toBe("readme");
  expect(resolveActiveScopeSurface([], "readme")).toBeNull();
});

test("prefers a capability-safe default over registry order", () => {
  expect(resolveActiveScopeSurface(surfaces, "context", "pages")?.id).toBe(
    "pages",
  );
});

test("uses readme for a registered space and pages for a collection owner", () => {
  expect(
    resolveDefaultScopeSurface(
      createRegisteredSpaceOwner({
        spaceId: "root",
        projectPath: "/repo",
        spacePath: "/repo",
        status: "ready",
        hasSchema: true,
      }),
    ),
  ).toBe("readme");
  expect(
    resolveDefaultScopeSurface(
      createCollectionDirectoryOwner({
        spaceId: "root",
        projectPath: "/repo",
        spacePath: "/repo",
        ownerPath: "tasks",
        status: "ready",
        hasSchema: true,
      }),
    ),
  ).toBe("pages");
  expect(
    resolveDefaultScopeSurface(
      createAppDirectoryOwner({
        spaceId: "root",
        projectPath: "/repo",
        spacePath: "/repo",
        ownerPath: "dashboard",
        status: "ready",
        hasApp: true,
      }),
    ),
  ).toBe("app");
});

test("an owner that is only an App opens on its App in main and Peek, a README or not", () => {
  const base = {
    spaceId: "root",
    projectPath: "/repo",
    spacePath: "/repo",
    status: "ready" as const,
  };
  const appDirectory = createAppDirectoryOwner({
    ...base,
    ownerPath: "dashboard",
    hasApp: true,
  });
  const appWithReadme = createPageOwner({
    ...base,
    form: "folder",
    ownerPath: "app-demo",
    contentPath: "app-demo/README.md",
    hasApp: true,
  });
  const pageFolder = createPageOwner({
    ...base,
    form: "folder",
    ownerPath: "notes",
    contentPath: "notes/README.md",
    hasApp: false,
  });
  const pageLeaf = createPageOwner({
    ...base,
    form: "leaf",
    contentPath: "note.md",
  });
  const space = createRegisteredSpaceOwner({ ...base, hasSchema: false });
  const spaceApp = createRegisteredSpaceOwner({
    ...base,
    hasSchema: false,
    hasApp: true,
  });
  const collectionApp = createCollectionDirectoryOwner({
    ...base,
    ownerPath: "tasks",
    hasSchema: true,
    hasApp: true,
  });
  for (const presentation of ["full", "compact"] as const) {
    expect(resolveDefaultScopeSurface(appDirectory, presentation)).toBe("app");
    expect(resolveDefaultScopeSurface(appWithReadme, presentation)).toBe("app");
    expect(resolveDefaultScopeSurface(pageFolder, presentation)).toBe("readme");
    expect(resolveDefaultScopeSurface(pageLeaf, presentation)).toBe("readme");
    expect(resolveDefaultScopeSurface(space, presentation)).toBe("readme");
    expect(resolveDefaultScopeSurface(spaceApp, presentation)).toBe("readme");
  }
  expect(resolveDefaultScopeSurface(collectionApp)).toBe("pages");
  // A nested Collection in Peek opens on its Readme.
  expect(resolveDefaultScopeSurface(collectionApp, "compact")).toBe("readme");
});
