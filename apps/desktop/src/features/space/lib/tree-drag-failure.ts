import { treeOrderUnreadableToast } from "@/features/page/page-api";

/** Toast content for a failed tree drag; an unreadable page order names its file. */
export function treeDragFailureToast(error: unknown): {
  title: string;
  description?: string;
} {
  return treeOrderUnreadableToast(error) ?? { title: "Failed to move file" };
}
