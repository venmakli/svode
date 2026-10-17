import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";

export function handleError(error: unknown) {
  console.error(error);
  toast.error(m.toast_error());
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
