import { takenNamePath } from "@/platform/space/content-tree-api";
import * as m from "@/paraglide/messages.js";

/**
 * Toast text for a structural operation refused because the name it wanted
 * is taken: the name and the folder it is taken in, the Space root by the
 * Space's name. Other errors, and a taken name in the root of a Space whose
 * name is unknown, return null for the caller's own text.
 */
export function takenNameMessage(
  error: unknown,
  spaceName: string | null,
): string | null {
  const path = takenNamePath(error);
  if (path === null) return null;
  const slash = path.lastIndexOf("/");
  const folder = slash < 0 ? spaceName : path.slice(0, slash);
  if (folder === null) return null;
  return m.page_name_taken({ name: path.slice(slash + 1), folder });
}
