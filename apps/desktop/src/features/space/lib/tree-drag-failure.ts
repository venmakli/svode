import * as m from "@/paraglide/messages.js";
import { treeOrderUnreadablePath } from "../api/space-store-actions";

/** Toast content for a failed tree drag; an unreadable page order names its file. */
export function treeDragFailureToast(error: unknown): {
  title: string;
  description?: string;
} {
  const orderPath = treeOrderUnreadablePath(error);
  if (!orderPath) return { title: "Failed to move file" };
  return {
    title: m.sidebar_order_unreadable(),
    description: m.sidebar_order_unreadable_description({ path: orderPath }),
  };
}
