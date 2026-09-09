import { expect, test } from "bun:test";
import {
  createCollectionDirectoryOwner,
  createAppDirectoryOwner,
  createRegisteredSpaceOwner,
  createPageOwner,
  resolveDefaultScopeSurface,
  resolveActiveScopeSurface,
  resolveScopeSurfaceContributions,
} from "@/features/scope-surfaces";
import { createScopeSurfaceContributions } from "./scope-surface-contributions";
import { attachmentOwnerFromScopeOwner } from "@/features/attachments";
import { appOwnerFromScopeOwner } from "@/features/apps";
import * as m from "@/paraglide/messages.js";

test("app registry exposes canonical Stage 7 surfaces for each owner", () => {
  const contributions = createScopeSurfaceContributions();
  const hybridSpace = createRegisteredSpaceOwner({
    spaceId: "root",
    projectPath: "/repo",
    spacePath: "/repo",
    status: "ready",
    hasSchema: true,
  });
  const plainSpace = createRegisteredSpaceOwner({
    spaceId: "plain",
    projectPath: "/repo",
    spacePath: "/repo/plain",
    status: "ready",
    hasSchema: false,
  });
  const collection = createCollectionDirectoryOwner({
    spaceId: "root",
    projectPath: "/repo",
    spacePath: "/repo",
    ownerPath: "tasks",
    status: "ready",
    hasSchema: true,
  });
  const app = createAppDirectoryOwner({
    spaceId: "root",
    projectPath: "/repo",
    spacePath: "/repo",
    ownerPath: "dashboard",
    status: "ready",
    hasApp: true,
  });

  expect(
    resolveScopeSurfaceContributions(contributions, hybridSpace, "full").map(
      ({ id }) => id,
    ),
  ).toEqual([
    "context",
    "readme",
    "collection",
    "attachments",
    "actors",
    "routines",
  ]);
  expect(
    resolveScopeSurfaceContributions(contributions, plainSpace, "full").map(
      ({ id }) => id,
    ),
  ).toEqual(["context", "readme", "attachments", "actors", "routines"]);
  expect(
    resolveScopeSurfaceContributions(contributions, collection, "compact").map(
      ({ id }) => id,
    ),
  ).toEqual(["readme", "collection", "routines"]);
  expect(
    resolveScopeSurfaceContributions(contributions, collection, "full").map(
      ({ id }) => id,
    ),
  ).toEqual(["readme", "collection", "routines"]);
  expect(
    resolveScopeSurfaceContributions(contributions, app, "full").map(
      ({ id }) => id,
    ),
  ).toEqual(["readme", "app"]);
});

test("canonical definitions cover the owner eligibility matrix without row or manifest validation inputs", () => {
  const contributions = createScopeSurfaceContributions();
  const base = {
    spaceId: "root",
    projectPath: "/repo",
    spacePath: "/repo",
    status: "ready" as const,
  };
  for (const hasApp of [false, true]) {
    const app = hasApp ? ["app"] : [];
    for (const hasSchema of [false, true]) {
      for (const spacePath of ["/repo", "/repo/child"]) {
        const space = createRegisteredSpaceOwner({
          ...base,
          spacePath,
          hasSchema,
          hasApp,
        });
        expect(
          resolveScopeSurfaceContributions(contributions, space, "full").map(
            ({ id }) => id,
          ),
        ).toEqual([
          "context",
          "readme",
          ...app,
          ...(hasSchema ? ["collection"] : []),
          "attachments",
          "actors",
          "routines",
        ]);
        expect(attachmentOwnerFromScopeOwner(space).hasDirectCollection).toBe(
          hasSchema,
        );
      }
    }
    const collection = createCollectionDirectoryOwner({
      ...base,
      ownerPath: "Tasks",
      hasSchema: true,
      hasApp,
    });
    for (const presentation of ["full", "compact"] as const) {
      expect(
        resolveScopeSurfaceContributions(
          contributions,
          collection,
          presentation,
        ).map(({ id }) => id),
      ).toEqual(["readme", ...app, "collection", "routines"]);
    }
    expectAttachmentRejected(collection);
    for (const spacePath of ["/repo", "/repo/child"]) {
      const page = createPageOwner({
        ...base,
        spacePath,
        form: "folder",
        contentPath: "Tasks/Item/README.md",
        ownerPath: "Tasks/Item",
        hasApp,
      });
      expect(
        resolveScopeSurfaceContributions(contributions, page, "full").map(
          ({ id }) => id,
        ),
      ).toEqual(["readme", ...app, "attachments"]);
      const mapped = attachmentOwnerFromScopeOwner(page);
      expect(mapped.identityKind).toBe("page-directory");
      expect(mapped.contentPath).toBe(page.readmePath);
      expect(mapped.hasDirectCollection).toBe(false);
      expect(mapped.spacePath).toBe(spacePath);
      expect(mapped.ownerPath).toBe("Tasks/Item");
      if (hasApp)
        expect(appOwnerFromScopeOwner(page)).toEqual({
          projectPath: "/repo",
          spacePath,
          spaceId: "root",
          ownerPath: "Tasks/Item",
        });
    }
  }
  const leaf = createPageOwner({
    ...base,
    form: "leaf",
    contentPath: "Notes.md",
  });
  expect(
    resolveScopeSurfaceContributions(contributions, leaf, "full").map(
      ({ id }) => id,
    ),
  ).toEqual(["readme"]);
  expectAttachmentRejected(leaf);
  const appOnly = createAppDirectoryOwner({
    ...base,
    ownerPath: "Tool",
    hasApp: true,
  });
  expect(
    resolveScopeSurfaceContributions(contributions, appOnly, "full").map(
      ({ id }) => id,
    ),
  ).toEqual(["readme", "app"]);
  expectAttachmentRejected(appOnly);
  expect(contributions.find(({ id }) => id === "readme")?.label).toBe(
    m.scope_surface_readme(),
  );
  expect(contributions.find(({ id }) => id === "app")?.label).toBe(
    m.scope_surface_app(),
  );
  expect(contributions.find(({ id }) => id === "attachments")?.label).toBe(
    m.scope_surface_attachments(),
  );
  expect(contributions.find(({ id }) => id === "app")?.fillAvailableSpace).toBe(
    true,
  );
});

test("removed app marker falls back to the owner default with the same definitions", () => {
  const page = createPageOwner({
    spaceId: "root",
    projectPath: "/repo",
    spacePath: "/repo",
    status: "ready",
    form: "folder",
    ownerPath: "Notes",
    contentPath: "Notes/README.md",
    hasApp: false,
  });
  const surfaces = resolveScopeSurfaceContributions(
    createScopeSurfaceContributions(),
    page,
    "full",
  );
  expect(
    resolveActiveScopeSurface(surfaces, "app", resolveDefaultScopeSurface(page))
      ?.id,
  ).toBe("readme");
});

function expectAttachmentRejected(
  owner: Parameters<typeof attachmentOwnerFromScopeOwner>[0],
) {
  let rejected = false;
  try {
    attachmentOwnerFromScopeOwner(owner);
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
}
