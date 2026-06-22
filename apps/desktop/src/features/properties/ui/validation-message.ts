import type { PropertyValidationCode } from "../model";
import * as m from "@/paraglide/messages.js";

export function propertyValidationMessage(
  code: PropertyValidationCode | undefined,
) {
  switch (code) {
    case "no_key":
      return m.property_state_no_key();
    case "invalid_key":
      return m.property_state_invalid_key();
    case "type_conflict":
      return m.property_state_type_conflict();
    case "invalid_option":
      return m.property_state_invalid_option();
    case "invalid_email_phone":
      return m.property_state_invalid_email_phone();
    default:
      return undefined;
  }
}
