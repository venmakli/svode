import type { ScopeOwnerRef } from "./types";

interface RegisteredSpaceOwnerInput {
  spaceId: string;
  spacePath: string;
  projectPath: string;
  status: "ready" | "missing" | "broken";
  hasSchema: boolean;
}

interface CollectionDirectoryOwnerInput {
  spaceId: string;
  spacePath: string;
  projectPath: string;
  ownerPath: string;
  status: "ready" | "missing" | "broken";
  hasSchema: boolean;
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
    capabilities: input.hasSchema ? ["space", "collection"] : ["space"],
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
    capabilities: ["collection"],
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
