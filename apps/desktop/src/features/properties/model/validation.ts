import * as m from "@/paraglide/messages.js";
import type { Column } from "./types";
import { normalizeUrlValue } from "../lib/url";
import {
  normalizeActorValues,
  hasOption,
  isDateRangeValue,
  isEmptyValue,
  isValidEmail,
  isValidPhone,
  isValidUrl,
} from "../lib/utils";

export function shouldClosePropertyEditorOnChange(type: Column["type"]) {
  return (
    type !== "date" &&
    type !== "multi_select" &&
    type !== "url" &&
    type !== "relation" &&
    type !== "actor"
  );
}

export function validatePropertyValue(
  column: Column,
  value: unknown,
): {
  invalid: boolean;
  message?: string;
} {
  if (column.type === "unique_id") {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return { invalid: false };
    }
    return {
      invalid: true,
      message: isEmptyValue(value)
        ? m.property_state_no_key()
        : m.property_state_invalid_key(),
    };
  }
  if (isEmptyValue(value)) return { invalid: false };
  switch (column.type) {
    case "number":
      return typeof value === "number"
        ? { invalid: false }
        : { invalid: true, message: m.property_state_type_conflict() };
    case "select":
    case "status":
      return typeof value === "string" && hasOption(column, value)
        ? { invalid: false }
        : { invalid: true, message: m.property_state_invalid_option() };
    case "multi_select":
      return Array.isArray(value) &&
        value.every(
          (item) => typeof item === "string" && hasOption(column, item),
        )
        ? { invalid: false }
        : { invalid: true, message: m.property_state_invalid_option() };
    case "checkbox":
      return typeof value === "boolean"
        ? { invalid: false }
        : { invalid: true, message: m.property_state_type_conflict() };
    case "date":
      return typeof value === "string" || isDateRangeValue(value)
        ? { invalid: false }
        : { invalid: true, message: m.property_state_type_conflict() };
    case "actor":
      if (column.multiple) {
        return Array.isArray(value) &&
          normalizeActorValues(value).length === value.length
          ? { invalid: false }
          : { invalid: true, message: m.property_state_type_conflict() };
      }
      return typeof value === "string"
        ? { invalid: false }
        : { invalid: true, message: m.property_state_type_conflict() };
    case "email":
      return typeof value === "string" && isValidEmail(value)
        ? { invalid: false }
        : { invalid: true, message: m.property_state_invalid_email_phone() };
    case "phone":
      return typeof value === "string" && isValidPhone(value)
        ? { invalid: false }
        : { invalid: true, message: m.property_state_invalid_email_phone() };
    case "url":
      return (typeof value === "string" && isValidUrl(value)) ||
        (value !== null &&
          typeof value === "object" &&
          isValidUrl(normalizeUrlValue(value).href))
        ? { invalid: false }
        : { invalid: true, message: m.property_state_type_conflict() };
    case "relation":
      return typeof value === "string" ||
        (Array.isArray(value) &&
          value.every((item) => typeof item === "string"))
        ? { invalid: false }
        : { invalid: true, message: m.property_state_type_conflict() };
    default:
      return { invalid: false };
  }
}
