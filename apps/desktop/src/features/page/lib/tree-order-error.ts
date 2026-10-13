import { treeOrderUnreadablePath } from "@/platform/space/content-tree-api";
import * as m from "@/paraglide/messages.js";

/**
 * Toast content for a page order write refused because the Space order file
 * cannot be read; it names the file. Other errors return null.
 */
export function treeOrderUnreadableToast(
  error: unknown,
): { title: string; description: string } | null {
  const path = treeOrderUnreadablePath(error);
  if (!path) return null;
  return {
    title: m.page_order_unreadable(),
    description: m.page_order_unreadable_description({ path }),
  };
}
