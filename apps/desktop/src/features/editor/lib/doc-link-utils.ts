export function isDocLink(url: string | undefined): boolean {
  if (!url) return false;
  if (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("mailto:") ||
    url.startsWith("#")
  ) {
    return false;
  }
  return url.split("#")[0].endsWith(".md");
}

export function joinAbs(base: string, rel: string): string {
  if (!rel) return base;
  if (rel.startsWith("/")) return rel;
  return `${base.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`;
}

export function relativeDocumentPath(path: string, spacePath: string): string {
  const normalizedSpace = spacePath.replace(/\/+$/, "");
  if (path === normalizedSpace) return "";
  if (path.startsWith(`${normalizedSpace}/`)) {
    return path.slice(normalizedSpace.length + 1);
  }
  return path;
}

export function absoluteDocumentPath(path: string, spacePath: string): string {
  return path.startsWith("/") ? path : joinAbs(spacePath, path);
}

export function stripAnchor(url: string): string {
  return url.split("#")[0];
}

export function makeRelativePath(
  fromAbsPath: string,
  toAbsPath: string,
): string {
  const fromParts = stripAnchor(fromAbsPath).split("/").filter(Boolean);
  fromParts.pop();
  const toParts = stripAnchor(toAbsPath).split("/").filter(Boolean);

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
  return parts.join("/") || toAbsPath;
}

export function resolveRelativeDocPath(
  currentDoc: string,
  relativeUrl: string,
): string {
  const url = stripAnchor(relativeUrl);
  const parts = currentDoc.split("/");
  parts.pop();

  for (const segment of url.split("/")) {
    if (segment === "..") {
      parts.pop();
    } else if (segment !== "." && segment !== "") {
      parts.push(segment);
    }
  }

  return parts.join("/");
}

export function findSpaceById<T extends { id: string }>(
  rootSpaces: T[],
  spaces: T[],
  id: string | null,
): T | null {
  if (!id) return null;
  return [...rootSpaces, ...spaces].find((space) => space.id === id) ?? null;
}
