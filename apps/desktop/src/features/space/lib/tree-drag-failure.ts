import {
  takenNameMessage,
  treeOrderUnreadableToast,
} from "@/features/page/page-api";
import * as m from "@/paraglide/messages.js";

/**
 * Toast content for a failed tree drag: an unreadable page order names its
 * file, a taken name names itself and its folder.
 */
export function treeDragFailureToast(
  error: unknown,
  spaceName: string | null,
): {
  title: string;
  description?: string;
} {
  return (
    treeOrderUnreadableToast(error) ?? {
      title: takenNameMessage(error, spaceName) ?? m.space_move_error(),
    }
  );
}
