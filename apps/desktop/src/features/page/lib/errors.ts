import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { takenNameMessage } from "./taken-name-error";

export function handleError(error: unknown) {
  console.error(error);
  toast.error(m.toast_error());
}

/**
 * A failed structural operation in a Space: a taken name names itself and
 * its folder, any other error shows the generic text.
 */
export function handleStructuralError(
  error: unknown,
  spaceName: string | null,
) {
  console.error(error);
  toast.error(takenNameMessage(error, spaceName) ?? m.toast_error());
}

export type PageHeaderSaveField =
  | "title"
  | "icon"
  | "description"
  | "cover"
  | "readme";

/** A failed write of a header field that leaves no draft to recover. */
export function showPageHeaderSaveError(
  field: PageHeaderSaveField,
  error: unknown,
) {
  console.error(error);
  toast.error(pageHeaderSaveErrorMessage(field));
}

function pageHeaderSaveErrorMessage(field: PageHeaderSaveField) {
  switch (field) {
    case "title":
      return m.page_save_error_title();
    case "icon":
      return m.page_save_error_icon();
    case "description":
      return m.page_save_error_description();
    case "cover":
      return m.page_save_error_cover();
    case "readme":
      return m.page_save_error_readme();
  }
}
