export function normalizeGitStatusPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

export function basename(path: string): string {
  const normalized = normalizeGitStatusPath(path);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

export function dirname(path: string): string {
  const normalized = normalizeGitStatusPath(path);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

export function isReadmePath(path: string): boolean {
  return basename(path).toLowerCase() === "readme.md";
}

export function containerPathForNodePath(path: string): string {
  const normalized = normalizeGitStatusPath(path);
  if (!normalized.endsWith(".md")) return normalized;
  if (isReadmePath(normalized)) return dirname(normalized);
  return dirname(normalized);
}

export function joinGitStatusPath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

export function isGitStatusPathDescendant(
  path: string,
  parentPath: string,
): boolean {
  const normalizedPath = normalizeGitStatusPath(path);
  const normalizedParent = normalizeGitStatusPath(parentPath);
  if (!normalizedParent) return normalizedPath !== "";
  return normalizedPath.startsWith(`${normalizedParent}/`);
}
