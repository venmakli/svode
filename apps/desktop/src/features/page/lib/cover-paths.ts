export function joinAbs(base: string, rel: string): string {
  if (!rel) return normalizeAbsPath(base);
  if (rel.startsWith("/")) return normalizeAbsPath(rel);
  return normalizeAbsPath(
    `${base.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`,
  );
}

export function coverPathForUploadedAsset({
  spacePath,
  assetOwnerPath,
  assetRelPath,
}: {
  spacePath: string;
  assetOwnerPath: string;
  assetRelPath: string;
}): string {
  return makeRelativePathFromDir(spacePath, joinAbs(assetOwnerPath, assetRelPath));
}

export function coverImageAbsPath(spacePath: string, coverPath: string): string {
  return joinAbs(spacePath, coverPath);
}

function makeRelativePathFromDir(fromDirAbs: string, toAbs: string): string {
  const fromParts = pathParts(fromDirAbs);
  const toParts = pathParts(toAbs);

  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }

  const ups = fromParts.length - common;
  const parts = [...Array<string>(ups).fill(".."), ...toParts.slice(common)];
  return parts.join("/") || ".";
}

function normalizeAbsPath(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

function pathParts(path: string): string[] {
  return normalizeAbsPath(path).split("/").filter(Boolean);
}
