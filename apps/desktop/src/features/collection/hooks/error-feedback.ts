import { toast } from "sonner";
import {
  pageNameConflictFromError,
  takenNameMessage,
  treeOrderUnreadableToast,
} from "@/features/page/page-api";
import * as m from "@/paraglide/messages.js";

export function handleError(error: unknown) {
  console.error(error);
  toast.error(m.toast_error());
}

export function handleItemCreateError(
  error: unknown,
  spaceName: string | null,
) {
  console.error(error);
  const conflict = pageNameConflictFromError(error);
  const conflictPath = conflict?.conflicts[0]?.path;
  toast.error(
    conflictPath
      ? m.page_name_conflict({ path: conflictPath })
      : (takenNameMessage(error, spaceName) ?? m.board_create_error()),
  );
}

/** Shows the unreadable page order toast; false for any other error. */
export function notifyTreeOrderUnreadable(error: unknown) {
  const orderToast = treeOrderUnreadableToast(error);
  if (!orderToast) return false;
  toast.error(orderToast.title, { description: orderToast.description });
  return true;
}

export function handleItemMoveError(error: unknown, spaceName: string | null) {
  if (notifyTreeOrderUnreadable(error)) return;
  toast.error(takenNameMessage(error, spaceName) ?? m.board_move_error());
}
