import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";

export function notifySpaceError() {
  toast.error(m.toast_error());
}

export function notifyProjectCreated() {
  toast.success(m.toast_project_created());
}

export function notifyProjectDeleted() {
  toast.success(m.toast_project_deleted());
}

export function notifySpaceCreated() {
  toast.success(m.toast_space_created());
}

export function notifySpaceDeleted() {
  toast.success(m.toast_space_deleted());
}

export function notifyPageCreated() {
  toast.success(m.toast_page_created());
}
