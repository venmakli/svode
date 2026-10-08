import { fileUriToPath } from "./attachments";

/**
 * Local paths in agent text (Stage 10 `08`, R3): links, paths in inline
 * code, and what later reads paths the same way. A path is untrusted
 * input; this only reads it, existence is checked by its consumer.
 */

/** A line or a range of lines named after the path. */
export interface LineSuffix {
  line: number;
  column: number | null;
  endLine: number | null;
}

export interface LocalReference {
  /** Absolute, with `.` and `..` resolved. */
  path: string;
  line: LineSuffix | null;
}

/** What relative paths and `~` resolve against. */
export interface PathBase {
  /** The session's working directory. */
  cwd: string | null;
  home: string | null;
}

export type LinkTarget =
  | { kind: "web"; url: string }
  | { kind: "local"; reference: LocalReference };

const WEB_LINK = /^https?:\/\//i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const DRIVE_PATH = /^[a-z]:[\\/]/i;
const FRAGMENT_LINES = /^L(\d+)(?:-L(\d+))?$/;
const COLON_RANGE = /:(\d+)-(\d+)$/;
const COLON_LINE = /:(\d+)(?::(\d+))?$/;
const HASH_LINES = /#L(\d+)(?:-L(\d+))?$/;

/**
 * What a link of agent text opens: a web page for `http(s)`, a local
 * object for an absolute path, a `file://` URI, a path from `~` or one
 * relative to the cwd; null for any other scheme, an anchor or a path
 * nothing resolves. A fragment is not part of the path.
 */
export function linkTarget(href: string, base: PathBase): LinkTarget | null {
  const value = href.trim();
  if (!value || value.startsWith("#")) return null;
  if (WEB_LINK.test(value)) {
    return isUrl(value) ? { kind: "web", url: value } : null;
  }
  const hash = value.indexOf("#");
  const fragment = hash >= 0 ? value.slice(hash + 1) : "";
  const written = hash >= 0 ? value.slice(0, hash) : value;
  const fragmentLines = FRAGMENT_LINES.exec(fragment);
  const fromFragment = fragmentLines
    ? lineSuffix(fragmentLines[1], null, fragmentLines[2])
    : null;

  if (/^file:/i.test(written)) {
    const path = fileUriToPath(written);
    if (!path) return null;
    const split = splitLineSuffix(path);
    const reference = resolved(
      split.path,
      fromFragment ?? split.line,
      base,
      false,
    );
    return reference && { kind: "local", reference };
  }
  const split = splitLineSuffix(decoded(written));
  if (
    !split.path ||
    (SCHEME.test(split.path) && !DRIVE_PATH.test(split.path))
  ) {
    return null;
  }
  const reference = resolved(
    split.path,
    fromFragment ?? split.line,
    base,
    true,
  );
  return reference && { kind: "local", reference };
}

/**
 * The local object an absolute path, a path from `~` or a `file://` URI
 * names, with its line suffix; relative paths too when `relative`. Null
 * for anything else.
 */
export function localReference(
  text: string,
  base: PathBase,
  { relative }: { relative: boolean },
): LocalReference | null {
  const value = text.trim();
  if (!value || value.includes("\n")) return null;
  if (/^file:/i.test(value)) {
    const target = linkTarget(value, base);
    return target?.kind === "local" ? target.reference : null;
  }
  const split = splitLineSuffix(value);
  return resolved(split.path, split.line, base, relative);
}

/**
 * The path in inline code: only an absolute path or one from `~`, never a
 * bare root, which reads as a command or a separator more often.
 */
export function inlineCodeReference(
  code: string,
  base: PathBase,
): LocalReference | null {
  const reference = localReference(code, base, { relative: false });
  if (!reference || isRoot(reference.path)) return null;
  return reference;
}

/** `:42`, `:42:7`, `:10-20`, `#L10` and `#L10-L20` split off the path. */
export function splitLineSuffix(text: string): {
  path: string;
  line: LineSuffix | null;
} {
  const hash = HASH_LINES.exec(text);
  if (hash) {
    return {
      path: text.slice(0, hash.index),
      line: lineSuffix(hash[1], null, hash[2]),
    };
  }
  const range = COLON_RANGE.exec(text);
  if (range && range.index > 0) {
    return {
      path: text.slice(0, range.index),
      line: lineSuffix(range[1], null, range[2]),
    };
  }
  const line = COLON_LINE.exec(text);
  if (line && line.index > 0) {
    return {
      path: text.slice(0, line.index),
      line: lineSuffix(line[1], line[2], undefined),
    };
  }
  return { path: text, line: null };
}

/** The suffix as `:42`, `:42:7` or `:10-20`. */
export function formatLineSuffix(line: LineSuffix): string {
  if (line.endLine !== null) return `:${line.line}-${line.endLine}`;
  if (line.column !== null) return `:${line.line}:${line.column}`;
  return `:${line.line}`;
}

function lineSuffix(
  line: string,
  column: string | null | undefined,
  endLine: string | null | undefined,
): LineSuffix {
  return {
    line: Number(line),
    column: column ? Number(column) : null,
    endLine: endLine ? Number(endLine) : null,
  };
}

function resolved(
  path: string,
  line: LineSuffix | null,
  base: PathBase,
  relative: boolean,
): LocalReference | null {
  if (!path) return null;
  let absolute: string;
  if (isAbsolute(path)) {
    absolute = path;
  } else if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) {
    if (!base.home) return null;
    absolute = joinPath(base.home, path.slice(1));
  } else if (relative && base.cwd && !path.startsWith("~")) {
    absolute = joinPath(base.cwd, path);
  } else {
    return null;
  }
  return { path: normalizePath(absolute), line };
}

/** An absolute path, Windows drive and UNC paths included. */
export function isAbsolute(path: string): boolean {
  return (
    path.startsWith("/") || path.startsWith("\\\\") || DRIVE_PATH.test(path)
  );
}

function isRoot(path: string): boolean {
  return /^(?:[a-z]:)?[\\/]*$/i.test(path);
}

function joinPath(base: string, path: string): string {
  const separator = separatorOf(base);
  return `${base.replace(/[\\/]+$/, "")}${separator}${path.replace(/^[\\/]+/, "")}`;
}

function separatorOf(path: string): "/" | "\\" {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

/** `.` and `..` resolved and repeated separators joined, root kept. */
function normalizePath(path: string): string {
  const separator = separatorOf(path);
  const root = /^(?:\\\\|[a-z]:[\\/]|\/)/i.exec(path)?.[0] ?? "";
  const segments: string[] = [];
  for (const segment of path.slice(root.length).split(/[\\/]+/)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return root + segments.join(separator);
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** A link percent-encodes what a path may hold as is. */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
