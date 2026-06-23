import type {
  ActorCandidate,
  CollectionSchema,
  ColorName,
  Column,
  DateRangeValue,
  PropertyOption,
  PropertyType,
  StatusGroup,
} from "../model/types";
import type { CSSProperties } from "react";

type ColumnInput = Omit<Column, "type"> & {
  type?: PropertyType;
  type_?: PropertyType;
  time_by_default?: boolean | null;
  range_by_default?: boolean | null;
  two_way?: string | null;
};

type CollectionSchemaInput = Omit<CollectionSchema, "columns"> & {
  system_fields?: {
    title?: { label?: string | null } | null;
  } | null;
  columns?: ColumnInput[];
};

export const PROPERTY_TYPES: { value: PropertyType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "select", label: "Select" },
  { value: "multi_select", label: "Multi-select" },
  { value: "status", label: "Status" },
  { value: "date", label: "Date" },
  { value: "unique_id", label: "ID" },
  { value: "actor", label: "Actor" },
  { value: "checkbox", label: "Checkbox" },
  { value: "url", label: "URL" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "relation", label: "Relation" },
];

export const STATUS_GROUPS: { value: StatusGroup; label: string }[] = [
  { value: "todo", label: "To-do" },
  { value: "in_progress", label: "In Progress" },
  { value: "done", label: "Done" },
];

export const COLOR_NAMES: ColorName[] = [
  "neutral",
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "brown",
];

export function normalizeColumn(column: ColumnInput): Column {
  const rawType = (column.type ??
    (column as unknown as { type_: PropertyType }).type_) as PropertyType;
  const type = rawType;
  const sensitivity =
    column.sensitivity ?? (type === "email" || type === "phone" ? "pii" : null);
  const {
    type_: _type,
    time_by_default: _timeByDefault,
    range_by_default: _rangeByDefault,
    two_way: _twoWay,
    ...rest
  } = column;
  return {
    ...rest,
    type,
    timeByDefault: column.timeByDefault ?? column.time_by_default ?? false,
    rangeByDefault: column.rangeByDefault ?? column.range_by_default ?? false,
    twoWay: column.twoWay ?? column.two_way ?? null,
    multiple: type === "actor" ? Boolean(column.multiple) : column.multiple,
    prefix:
      typeof column.prefix === "string" && column.prefix.trim()
        ? column.prefix.trim()
        : null,
    sensitivity,
  };
}

export function normalizeSchema(
  schema: CollectionSchemaInput,
): CollectionSchema {
  const { system_fields: _systemFields, ...rest } = schema;
  return {
    ...rest,
    systemFields: schema.systemFields ?? schema.system_fields ?? null,
    columns: (schema.columns ?? []).map(normalizeColumn),
  };
}

export function optionColor(option?: PropertyOption | null): ColorName {
  return option?.color ?? "neutral";
}

export function colorStyle(color: ColorName = "neutral") {
  return {
    "--property-color": `var(--property-${color})`,
    "--property-color-soft": `var(--property-${color}-soft)`,
  } as CSSProperties;
}

export function optionByName(
  column: Column,
  value: unknown,
): PropertyOption | undefined {
  if (typeof value !== "string") return undefined;
  return column.options?.find((option) => option.name === value) ?? undefined;
}

export function hasOption(column: Column, value: string): boolean {
  return Boolean(column.options?.some((option) => option.name === value));
}

export function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

export function isSensitivePropertyType(type: PropertyType): boolean {
  return type === "email" || type === "phone";
}

export function isSensitiveColumn(column: Column): boolean {
  return (
    column.sensitivity === "pii" ||
    (column.sensitivity == null && isSensitivePropertyType(column.type))
  );
}

export function valueToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

export function uniqueIdNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function uniqueIdDisplay(column: Column, value: unknown): string {
  const number = uniqueIdNumber(value);
  if (number === null) return "";
  const prefix = column.prefix?.trim();
  return prefix ? `${prefix}-${number}` : String(number);
}

export function uniqueIdRawDisplay(value: unknown): string {
  if (isEmptyValue(value)) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

export function normalizeActorValues(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];
  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const email = item.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    values.push(email);
  }
  return values;
}

export function resolveActorCandidate(email: string, actors: ActorCandidate[]): ActorCandidate {
  return (
    actors.find(
      (actor) => actor.email.toLowerCase() === email.toLowerCase(),
    ) ?? {
      email,
      name: email,
      commitCount: 0,
      isMe: false,
    }
  );
}

export function isValidEmail(value: string): boolean {
  if (!value) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function isValidPhone(value: string): boolean {
  if (!value) return true;
  return /^\+?[0-9][0-9()\-\s.]{4,}$/.test(value.trim());
}

export function isValidUrl(value: string): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function initialsForActor(
  actor: Pick<ActorCandidate, "name" | "email">,
): string {
  const label = actor.name || actor.email;
  const parts = label
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase()).join("") || "?";
}

export function actorDisplayName(actor: ActorCandidate): string {
  return actor.name || actor.email;
}

export function actorCommitCount(actor: ActorCandidate): number {
  return actor.commitCount ?? 0;
}

export function actorLastCommitAt(actor: ActorCandidate): number | null {
  return actor.lastCommitAt ?? null;
}

export function actorIsMe(actor: ActorCandidate): boolean {
  return actor.isMe ?? false;
}

export function hashIndex(value: string, modulo: number): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return Math.abs(hash >>> 0) % modulo;
}

export function gravatarUrl(email: string): string {
  const digest = md5(email.trim().toLowerCase());
  return `https://www.gravatar.com/avatar/${digest}?d=404&s=64`;
}

export function normalizeDateInput(value: unknown): {
  start: string;
  end: string;
  hasTime: boolean;
  isRange: boolean;
} {
  if (isDateRangeValue(value)) {
    return {
      start: value.start,
      end: value.end,
      hasTime: value.start.includes("T") || value.end.includes("T"),
      isRange: true,
    };
  }
  if (typeof value === "string") {
    return {
      start: value,
      end: value,
      hasTime: value.includes("T"),
      isRange: false,
    };
  }
  return {
    start: "",
    end: "",
    hasTime: false,
    isRange: false,
  };
}

export function isDateRangeValue(value: unknown): value is DateRangeValue {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as DateRangeValue).start === "string" &&
    typeof (value as DateRangeValue).end === "string"
  );
}

export function todayIsoDate(offsetDays = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatDateValue(
  value: unknown,
  display: string | null | undefined,
): string {
  const normalized = normalizeDateInput(value);
  if (!normalized.start) return "";
  const start = formatOneDate(normalized.start, display);
  if (!normalized.isRange) return start;
  const end = formatOneDate(normalized.end, display);
  return `${start} - ${end}`;
}

function formatOneDate(
  value: string,
  display: string | null | undefined,
): string {
  const date = new Date(value.includes("T") ? value : `${value}T00:00`);
  if (Number.isNaN(date.getTime())) return value;
  const dateStyle =
    display === "short" ? "short" : display === "long" ? "long" : "medium";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle,
    ...(value.includes("T") ? { timeStyle: "short" as const } : {}),
  }).format(date);
}

function md5(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const words: number[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    words[index >> 2] |= bytes[index] << ((index % 4) * 8);
  }
  const bitLength = bytes.length * 8;
  words[bitLength >> 5] |= 0x80 << (bitLength % 32);
  words[(((bitLength + 64) >>> 9) << 4) + 14] = bitLength;

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  for (let i = 0; i < words.length; i += 16) {
    const oldA = a;
    const oldB = b;
    const oldC = c;
    const oldD = d;

    a = ff(a, b, c, d, words[i], 7, -680876936);
    d = ff(d, a, b, c, words[i + 1], 12, -389564586);
    c = ff(c, d, a, b, words[i + 2], 17, 606105819);
    b = ff(b, c, d, a, words[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, words[i + 4], 7, -176418897);
    d = ff(d, a, b, c, words[i + 5], 12, 1200080426);
    c = ff(c, d, a, b, words[i + 6], 17, -1473231341);
    b = ff(b, c, d, a, words[i + 7], 22, -45705983);
    a = ff(a, b, c, d, words[i + 8], 7, 1770035416);
    d = ff(d, a, b, c, words[i + 9], 12, -1958414417);
    c = ff(c, d, a, b, words[i + 10], 17, -42063);
    b = ff(b, c, d, a, words[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, words[i + 12], 7, 1804603682);
    d = ff(d, a, b, c, words[i + 13], 12, -40341101);
    c = ff(c, d, a, b, words[i + 14], 17, -1502002290);
    b = ff(b, c, d, a, words[i + 15], 22, 1236535329);

    a = gg(a, b, c, d, words[i + 1], 5, -165796510);
    d = gg(d, a, b, c, words[i + 6], 9, -1069501632);
    c = gg(c, d, a, b, words[i + 11], 14, 643717713);
    b = gg(b, c, d, a, words[i], 20, -373897302);
    a = gg(a, b, c, d, words[i + 5], 5, -701558691);
    d = gg(d, a, b, c, words[i + 10], 9, 38016083);
    c = gg(c, d, a, b, words[i + 15], 14, -660478335);
    b = gg(b, c, d, a, words[i + 4], 20, -405537848);
    a = gg(a, b, c, d, words[i + 9], 5, 568446438);
    d = gg(d, a, b, c, words[i + 14], 9, -1019803690);
    c = gg(c, d, a, b, words[i + 3], 14, -187363961);
    b = gg(b, c, d, a, words[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, words[i + 13], 5, -1444681467);
    d = gg(d, a, b, c, words[i + 2], 9, -51403784);
    c = gg(c, d, a, b, words[i + 7], 14, 1735328473);
    b = gg(b, c, d, a, words[i + 12], 20, -1926607734);

    a = hh(a, b, c, d, words[i + 5], 4, -378558);
    d = hh(d, a, b, c, words[i + 8], 11, -2022574463);
    c = hh(c, d, a, b, words[i + 11], 16, 1839030562);
    b = hh(b, c, d, a, words[i + 14], 23, -35309556);
    a = hh(a, b, c, d, words[i + 1], 4, -1530992060);
    d = hh(d, a, b, c, words[i + 4], 11, 1272893353);
    c = hh(c, d, a, b, words[i + 7], 16, -155497632);
    b = hh(b, c, d, a, words[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, words[i + 13], 4, 681279174);
    d = hh(d, a, b, c, words[i], 11, -358537222);
    c = hh(c, d, a, b, words[i + 3], 16, -722521979);
    b = hh(b, c, d, a, words[i + 6], 23, 76029189);
    a = hh(a, b, c, d, words[i + 9], 4, -640364487);
    d = hh(d, a, b, c, words[i + 12], 11, -421815835);
    c = hh(c, d, a, b, words[i + 15], 16, 530742520);
    b = hh(b, c, d, a, words[i + 2], 23, -995338651);

    a = ii(a, b, c, d, words[i], 6, -198630844);
    d = ii(d, a, b, c, words[i + 7], 10, 1126891415);
    c = ii(c, d, a, b, words[i + 14], 15, -1416354905);
    b = ii(b, c, d, a, words[i + 5], 21, -57434055);
    a = ii(a, b, c, d, words[i + 12], 6, 1700485571);
    d = ii(d, a, b, c, words[i + 3], 10, -1894986606);
    c = ii(c, d, a, b, words[i + 10], 15, -1051523);
    b = ii(b, c, d, a, words[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, words[i + 8], 6, 1873313359);
    d = ii(d, a, b, c, words[i + 15], 10, -30611744);
    c = ii(c, d, a, b, words[i + 6], 15, -1560198380);
    b = ii(b, c, d, a, words[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, words[i + 4], 6, -145523070);
    d = ii(d, a, b, c, words[i + 11], 10, -1120210379);
    c = ii(c, d, a, b, words[i + 2], 15, 718787259);
    b = ii(b, c, d, a, words[i + 9], 21, -343485551);

    a = add32(a, oldA);
    b = add32(b, oldB);
    c = add32(c, oldC);
    d = add32(d, oldD);
  }

  return [a, b, c, d].map(toHex).join("");
}

function cmn(
  q: number,
  a: number,
  b: number,
  x: number,
  s: number,
  t: number,
): number {
  return add32(rotateLeft(add32(add32(a, q), add32(x || 0, t)), s), b);
}

function ff(
  a: number,
  b: number,
  c: number,
  d: number,
  x: number,
  s: number,
  t: number,
): number {
  return cmn((b & c) | (~b & d), a, b, x, s, t);
}

function gg(
  a: number,
  b: number,
  c: number,
  d: number,
  x: number,
  s: number,
  t: number,
): number {
  return cmn((b & d) | (c & ~d), a, b, x, s, t);
}

function hh(
  a: number,
  b: number,
  c: number,
  d: number,
  x: number,
  s: number,
  t: number,
): number {
  return cmn(b ^ c ^ d, a, b, x, s, t);
}

function ii(
  a: number,
  b: number,
  c: number,
  d: number,
  x: number,
  s: number,
  t: number,
): number {
  return cmn(c ^ (b | ~d), a, b, x, s, t);
}

function rotateLeft(value: number, count: number): number {
  return (value << count) | (value >>> (32 - count));
}

function add32(a: number, b: number): number {
  return (a + b) & 0xffffffff;
}

function toHex(value: number): string {
  let output = "";
  for (let index = 0; index < 4; index += 1) {
    output += ((value >> (index * 8)) & 0xff).toString(16).padStart(2, "0");
  }
  return output;
}
