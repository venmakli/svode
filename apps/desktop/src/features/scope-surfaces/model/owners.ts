import type { ScopeOwnerRef } from "./types";

interface RegisteredSpaceOwnerInput {
  spaceId: string;
  spacePath: string;
  projectPath: string;
  status: "ready" | "missing" | "broken";
  hasSchema: boolean;
  hasApp?: boolean;
}

interface CollectionDirectoryOwnerInput {
  spaceId: string;
  spacePath: string;
  projectPath: string;
  ownerPath: string;
  status: "ready" | "missing" | "broken";
  hasSchema: boolean;
  hasApp?: boolean;
}

interface AppDirectoryOwnerInput {
  spaceId: string;
  spacePath: string;
  projectPath: string;
  ownerPath: string;
  status: "ready" | "missing" | "broken";
  hasApp: boolean;
}

export function createRegisteredSpaceOwner(
  input: RegisteredSpaceOwnerInput,
): ScopeOwnerRef {
  assertReadySpace(input.status);
  assertIdentifier(input.spaceId, "spaceId");
  assertAbsolutePath(input.projectPath, "projectPath");
  assertAbsolutePath(input.spacePath, "spacePath");

  return {
    ownerKey: `space:${input.spaceId}`,
    identityKind: "registered-space",
    spaceId: input.spaceId,
    spacePath: input.spacePath,
    projectPath: input.projectPath,
    ownerPath: ".",
    readmePath: "README.md",
    capabilities: [
      "space",
      ...(input.hasSchema ? (["collection"] as const) : []),
      ...(input.hasApp ? (["app"] as const) : []),
    ],
  };
}

export function createCollectionDirectoryOwner(
  input: CollectionDirectoryOwnerInput,
): ScopeOwnerRef {
  assertReadySpace(input.status);
  if (!input.hasSchema) {
    throw new Error("Collection directory owners require a direct schema.yaml");
  }
  assertIdentifier(input.spaceId, "spaceId");
  assertAbsolutePath(input.projectPath, "projectPath");
  assertAbsolutePath(input.spacePath, "spacePath");
  const ownerPath = assertNormalizedOwnerPath(input.ownerPath);
  if (ownerPath === ".") {
    throw new Error(
      "A root registered space must use registered-space identity",
    );
  }

  return {
    ownerKey: `collection:${input.spaceId}:${ownerPath}`,
    identityKind: "collection-directory",
    spaceId: input.spaceId,
    spacePath: input.spacePath,
    projectPath: input.projectPath,
    ownerPath,
    readmePath: `${ownerPath}/README.md`,
    capabilities: ["collection", ...(input.hasApp ? (["app"] as const) : [])],
  };
}

export function createAppDirectoryOwner(
  input: AppDirectoryOwnerInput,
): ScopeOwnerRef {
  assertReadySpace(input.status);
  if (!input.hasApp) {
    throw new Error("App directory owners require a direct app.yaml");
  }
  assertIdentifier(input.spaceId, "spaceId");
  assertAbsolutePath(input.projectPath, "projectPath");
  assertAbsolutePath(input.spacePath, "spacePath");
  const ownerPath = assertNormalizedOwnerPath(input.ownerPath);
  if (ownerPath === ".") {
    throw new Error(
      "A root registered space must use registered-space identity",
    );
  }

  return {
    ownerKey: `app:${input.spaceId}:${ownerPath}`,
    identityKind: "app-directory",
    spaceId: input.spaceId,
    spacePath: input.spacePath,
    projectPath: input.projectPath,
    ownerPath,
    readmePath: `${ownerPath}/README.md`,
    capabilities: ["app"],
  };
}

type PageOwnerInput = {
  spaceId: string;
  spacePath: string;
  projectPath: string;
  status: "ready" | "missing" | "broken";
  contentPath: string;
} & ({ form: "leaf" } | { form: "folder"; ownerPath: string; hasApp: boolean });

export function createPageOwner(input: PageOwnerInput): ScopeOwnerRef {
  assertReadySpace(input.status);
  assertIdentifier(input.spaceId, "spaceId");
  assertAbsolutePath(input.projectPath, "projectPath");
  assertAbsolutePath(input.spacePath, "spacePath");
  const contentPath = assertNormalizedOwnerPath(input.contentPath);
  const ownerPath =
    input.form === "folder"
      ? assertNormalizedOwnerPath(input.ownerPath)
      : contentPath;
  if (contentPath === "." || ownerPath === ".") {
    throw new Error(
      "A root registered space must use registered-space identity",
    );
  }
  if (
    input.form === "folder" &&
    (contentPath.slice(0, contentPath.lastIndexOf("/")) !== ownerPath ||
      contentPath.slice(contentPath.lastIndexOf("/") + 1).toLowerCase() !==
        "readme.md")
  ) {
    throw new Error("Folder Page content must be its direct README.md");
  }
  return {
    ownerKey: `page:${input.spaceId}:${ownerPath}`,
    identityKind: input.form === "folder" ? "page-directory" : "page-file",
    spaceId: input.spaceId,
    spacePath: input.spacePath,
    projectPath: input.projectPath,
    ownerPath,
    readmePath: contentPath,
    capabilities: input.form === "folder" && input.hasApp ? ["app"] : [],
  };
}

export function assertNormalizedOwnerPath(ownerPath: string): string {
  // Tree/watcher DTO paths are normalized by Rust normalize_repo_relative.
  // This guard prevents app composition from accepting a different path shape.
  if (
    !ownerPath ||
    ownerPath.startsWith("/") ||
    ownerPath.startsWith("\\") ||
    /^[A-Za-z]:/.test(ownerPath) ||
    ownerPath.includes("\\")
  ) {
    throw new Error("ownerPath must be a normalized repo-relative path");
  }

  if (ownerPath === ".") return ownerPath;
  const segments = ownerPath.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("ownerPath contains an invalid path segment");
  }
  return ownerPath;
}

function assertReadySpace(status: RegisteredSpaceOwnerInput["status"]) {
  if (status !== "ready") {
    throw new Error("Scope Surface owners require a ready space");
  }
}

function assertIdentifier(value: string, name: string) {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

function assertAbsolutePath(value: string, name: string) {
  const isAbsolute =
    value.startsWith("/") ||
    value.startsWith("\\\\") ||
    value.startsWith("//") ||
    /^[A-Za-z]:[\\/]/.test(value);
  if (!value || !isAbsolute) {
    throw new Error(`${name} must be an absolute filesystem path`);
  }
}
