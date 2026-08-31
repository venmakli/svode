import { toast } from "sonner";
import { pageNameConflictFromError } from "@/features/page/page-api";
import * as m from "@/paraglide/messages.js";

export function handleError(error: unknown) {
  console.error(error);
  toast.error(m.toast_error());
}

export function handleEntryCreateError(error: unknown) {
  console.error(error);
  const conflict = pageNameConflictFromError(error);
  const conflictPath = conflict?.conflicts[0]?.path;
  toast.error(
    conflictPath
      ? m.page_name_conflict({ path: conflictPath })
      : m.board_create_error(),
  );
}
