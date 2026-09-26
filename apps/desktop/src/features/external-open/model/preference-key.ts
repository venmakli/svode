/** The project directory: one remembered application for every project. */
export const DIRECTORY_PREFERENCE_KEY = "directory";

/**
 * One remembered application per file extension, case-insensitive; files
 * without an extension share one key.
 */
export function filePreferenceKey(path: string): string {
  const name = path.replaceAll("\\", "/").split("/").at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  return `file:${dot > 0 ? name.slice(dot + 1).toLowerCase() : ""}`;
}
