import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";

export function propertyErrorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return m.toast_error();
}

export function notifyPropertyAddFailed(error: unknown) {
  console.error(error);
  toast.error(m.property_add_failed());
}
