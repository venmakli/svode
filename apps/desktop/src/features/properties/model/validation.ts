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

export type PropertyValidationCode =
  | "no_key"
  | "invalid_key"
  | "type_conflict"
  | "invalid_option"
  | "invalid_email_phone";

export interface PropertyValidationState {
  invalid: boolean;
  code?: PropertyValidationCode;
}

function validPropertyValue(): PropertyValidationState {
  return { invalid: false };
}

function invalidPropertyValue(
  code: PropertyValidationCode,
): PropertyValidationState {
  return { invalid: true, code };
}

export function validatePropertyValue(
  column: Column,
  value: unknown,
): PropertyValidationState {
  if (column.type === "unique_id") {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return validPropertyValue();
    }
    return invalidPropertyValue(isEmptyValue(value) ? "no_key" : "invalid_key");
  }
  if (isEmptyValue(value)) return validPropertyValue();
  switch (column.type) {
    case "number":
      return typeof value === "number"
        ? validPropertyValue()
        : invalidPropertyValue("type_conflict");
    case "select":
    case "status":
      return typeof value === "string" && hasOption(column, value)
        ? validPropertyValue()
        : invalidPropertyValue("invalid_option");
    case "multi_select":
      return Array.isArray(value) &&
        value.every(
          (item) => typeof item === "string" && hasOption(column, item),
        )
        ? validPropertyValue()
        : invalidPropertyValue("invalid_option");
    case "checkbox":
      return typeof value === "boolean"
        ? validPropertyValue()
        : invalidPropertyValue("type_conflict");
    case "date":
      return typeof value === "string" || isDateRangeValue(value)
        ? validPropertyValue()
        : invalidPropertyValue("type_conflict");
    case "actor":
      if (column.multiple) {
        return Array.isArray(value) &&
          normalizeActorValues(value).length === value.length
          ? validPropertyValue()
          : invalidPropertyValue("type_conflict");
      }
      return typeof value === "string"
        ? validPropertyValue()
        : invalidPropertyValue("type_conflict");
    case "email":
      return typeof value === "string" && isValidEmail(value)
        ? validPropertyValue()
        : invalidPropertyValue("invalid_email_phone");
    case "phone":
      return typeof value === "string" && isValidPhone(value)
        ? validPropertyValue()
        : invalidPropertyValue("invalid_email_phone");
    case "url":
      return (typeof value === "string" && isValidUrl(value)) ||
        (value !== null &&
          typeof value === "object" &&
          isValidUrl(normalizeUrlValue(value).href))
        ? validPropertyValue()
        : invalidPropertyValue("type_conflict");
    case "relation":
      return typeof value === "string" ||
        (Array.isArray(value) &&
          value.every((item) => typeof item === "string"))
        ? validPropertyValue()
        : invalidPropertyValue("type_conflict");
    default:
      return validPropertyValue();
  }
}
