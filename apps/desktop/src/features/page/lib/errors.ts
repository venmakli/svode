import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";

export function handleError(error: unknown) {
  console.error(error);
  toast.error(m.toast_error());
}
