export function isPageLink(url: string | undefined): boolean {
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

const PERCENT_ESCAPES = /^(?:%[0-9A-Fa-f]{2})+$/;

function utf8SequenceLength(leadByte: number): number {
  if (leadByte < 0x80) return 1;
  if (leadByte >= 0xc2 && leadByte <= 0xdf) return 2;
  if (leadByte >= 0xe0 && leadByte <= 0xef) return 3;
  if (leadByte >= 0xf0 && leadByte <= 0xf4) return 4;
  return 0;
}

function decodeUtf8Escapes(escapes: string): string | null {
  if (!PERCENT_ESCAPES.test(escapes)) return null;
  try {
    return decodeURIComponent(escapes);
  } catch {
    return null;
  }
}

/**
 * Percent-decode a link path once, as UTF-8, the way the backend link model
 * does: every `%XX` is decoded, while a `%` without two hex digits and escapes
 * that do not form valid UTF-8 stay literal. Pass the path without its anchor.
 */
export function decodePageLinkPath(raw: string): string {
  if (!raw.includes("%")) return raw;
  let out = "";
  let index = 0;
  while (index < raw.length) {
    const escape = raw.slice(index, index + 3);
    if (!PERCENT_ESCAPES.test(escape)) {
      out += raw[index];
      index += 1;
      continue;
    }
    const length = utf8SequenceLength(Number.parseInt(escape.slice(1), 16));
    const decoded =
      length > 0
        ? decodeUtf8Escapes(raw.slice(index, index + length * 3))
        : null;
    if (decoded === null) {
      out += escape;
      index += 3;
    } else {
      out += decoded;
      index += length * 3;
    }
  }
  return out;
}

/**
 * Path of a Page link url as `validate_links` reports it: anchor cut before
 * decoding, then percent-decoded and normalized with leading `..` kept.
 */
export function pageLinkPath(url: string): string {
  const parts: string[] = [];
  let leadingParents = 0;
  for (const segment of decodePageLinkPath(stripAnchor(url)).split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") {
      if (parts.pop() === undefined) leadingParents += 1;
    } else {
      parts.push(segment);
    }
  }
  return [...Array<string>(leadingParents).fill(".."), ...parts].join("/");
}

/** Write a literal `%` of a Page link path as `%25`, so it decodes back. */
export function encodePageLinkPath(path: string): string {
  return path.toLowerCase().endsWith(".md")
    ? path.replaceAll("%", "%25")
    : path;
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
  return encodePageLinkPath(parts.join("/") || toAbsPath);
}

export function resolveRelativeDocPath(
  currentDoc: string,
  relativeUrl: string,
): string {
  const url = decodePageLinkPath(stripAnchor(relativeUrl));
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

export function isBrokenPageLink(
  brokenLinks: ReadonlySet<string>,
  url: string | undefined,
  sourcePath: string | null,
): boolean {
  if (!url || !isPageLink(url)) return false;
  return (
    brokenLinks.has(pageLinkPath(url)) ||
    (sourcePath !== null &&
      brokenLinks.has(resolveRelativeDocPath(sourcePath, url)))
  );
}

export function findSpaceById<T extends { id: string }>(
  rootSpaces: T[],
  spaces: T[],
  id: string | null,
): T | null {
  if (!id) return null;
  return [...rootSpaces, ...spaces].find((space) => space.id === id) ?? null;
}
