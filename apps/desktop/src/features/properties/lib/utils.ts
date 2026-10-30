import type {
  ActorCandidate,
  CollectionSchema,
  ColorName,
  Column,
  DateRangeValue,
  NewerSvode,
  PropertyOption,
  PropertyType,
  RelationScope,
  StatusGroup,
} from "../model/types";
import type { CSSProperties } from "react";

type ColumnInput = Omit<Column, "type" | "relationScope"> & {
  type?: PropertyType;
  type_?: PropertyType;
  time_by_default?: boolean | null;
  range_by_default?: boolean | null;
  relationScope?: unknown;
  relation_scope?: unknown;
  two_way?: string | null;
};

type CollectionSchemaInput = Omit<CollectionSchema, "columns"> & {
  system_fields?: {
    title?: { label?: string | null } | null;
  } | null;
  columns?: ColumnInput[];
  newer_svode?: NewerSvode | null;
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
  { value: "boolean", label: "Yes / no" },
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

export function normalizeColumn(
  column: ColumnInput,
  newerColumns: ReadonlySet<string> = new Set(),
): Column {
  const rawType = column.type ?? column.type_;
  const newer =
    column.newer === true ||
    newerColumns.has(column.name) ||
    !isPropertyType(rawType);
  // A property of a newer version keeps no unknown type: every surface shows
  // it read-only as text.
  const type = isPropertyType(rawType) ? rawType : "text";
  const sensitivity =
    column.sensitivity ?? (type === "email" || type === "phone" ? "pii" : null);
  const {
    type_: _type,
    time_by_default: _timeByDefault,
    range_by_default: _rangeByDefault,
    relation_scope: _relationScope,
    two_way: _twoWay,
    ...rest
  } = column;
  return {
    ...rest,
    type,
    timeByDefault: column.timeByDefault ?? column.time_by_default ?? false,
    rangeByDefault: column.rangeByDefault ?? column.range_by_default ?? false,
    relationScope: normalizeRelationScope(
      column.relationScope ?? column.relation_scope,
    ),
    twoWay: column.twoWay ?? column.two_way ?? null,
    multiple: type === "actor" ? Boolean(column.multiple) : column.multiple,
    prefix:
      typeof column.prefix === "string" && column.prefix.trim()
        ? column.prefix.trim()
        : null,
    sensitivity,
    ...(newer ? { newer } : {}),
  };
}

export function normalizeSchema(
  schema: CollectionSchemaInput,
): CollectionSchema {
  const {
    system_fields: _systemFields,
    newer_svode: _newerSvode,
    ...rest
  } = schema;
  const newerSvode = schema.newerSvode ?? schema.newer_svode ?? null;
  const newerColumns = new Set(newerSvode?.columns ?? []);
  return {
    ...rest,
    systemFields: schema.systemFields ?? schema.system_fields ?? null,
    columns: (schema.columns ?? []).map((column) =>
      normalizeColumn(column, newerColumns),
    ),
    newerSvode,
  };
}

/** The value of a property of a newer version, as text read-only. */
export function newerValueText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => newerValueText(item)).join(", ");
  }
  return valueToString(value);
}

function normalizeRelationScope(value: unknown): RelationScope | null {
  if (value === "root") return "root";
  if (!value || typeof value !== "object") return null;
  const scope = value as { type?: unknown; id?: unknown };
  if (scope.type === "root") return "root";
  if (scope.type === "space" && typeof scope.id === "string") {
    return { type: "space", id: scope.id };
  }
  return null;
}

function isPropertyType(value: unknown): value is PropertyType {
  return PROPERTY_TYPES.some((item) => item.value === value);
}

/** A known color name, or `null` for none or one of a newer version. */
export function knownColorName(value: unknown): ColorName | null {
  return COLOR_NAMES.includes(value as ColorName) ? (value as ColorName) : null;
}

export function isKnownStatusGroup(value: unknown): value is StatusGroup {
  return STATUS_GROUPS.some((group) => group.value === value);
}

/** Whether an option of the status has a group of a newer version. */
export function hasNewerStatusGroup(column: Column): boolean {
  return Boolean(
    column.type === "status" &&
    column.options?.some(
      (option) => option.group != null && !isKnownStatusGroup(option.group),
    ),
  );
}

export function optionColor(option?: PropertyOption | null): ColorName {
  return knownColorName(option?.color) ?? "neutral";
}

/** A color of a newer version is drawn as `fallback`. */
export function colorStyle(
  value?: ColorName | null,
  fallback: ColorName = "neutral",
) {
  const color = knownColorName(value) ?? fallback;
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

/** A `sensitivity` of a newer version counts as `pii`. */
export function isSensitiveColumn(column: Column): boolean {
  return column.sensitivity == null
    ? isSensitivePropertyType(column.type)
    : column.sensitivity !== "none";
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

export function actorCandidateKey(actor: ActorCandidate): string {
  return (actor.kind === "agent" ? actor.reference : actor.email)
    .trim()
    .toLowerCase();
}

/** Candidates a picker may offer: unresolved agent references only render values. */
export function isSelectableActorCandidate(actor: ActorCandidate): boolean {
  return actor.kind !== "agent" || !actor.state;
}

export function resolveActorCandidate(
  value: string,
  actors: readonly ActorCandidate[],
): ActorCandidate {
  const normalized = value.trim().toLowerCase();
  const exact = actors.find((actor) => actorCandidateKey(actor) === normalized);
  if (exact) return exact;
  const aliases = actors.filter(
    (actor) =>
      actor.kind !== "agent" &&
      actor.aliasEmails?.some(
        (alias) => alias.trim().toLowerCase() === normalized,
      ),
  );
  return (
    (aliases.length === 1 ? aliases[0] : null) ?? {
      email: value,
      name: value,
      commitCount: 0,
      isMe: false,
    }
  );
}

export function resolveActorCandidates(
  values: string[],
  actors: readonly ActorCandidate[],
): ActorCandidate[] {
  const resolved = new Map<string, ActorCandidate>();
  for (const value of values) {
    const actor = resolveActorCandidate(value, actors);
    const key = actorCandidateKey(actor);
    if (!resolved.has(key)) resolved.set(key, actor);
  }
  return [...resolved.values()];
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

export function actorDisplayName(actor: ActorCandidate): string {
  return actor.kind === "agent" ? actor.name : actor.name || actor.email;
}

export function actorCommitCount(actor: ActorCandidate): number {
  return actor.kind === "agent" ? 0 : (actor.commitCount ?? 0);
}

export function actorLastCommitAt(actor: ActorCandidate): number | null {
  return actor.kind === "agent" ? null : (actor.lastCommitAt ?? null);
}

export function actorIsMe(actor: ActorCandidate): boolean {
  return actor.kind !== "agent" && (actor.isMe ?? false);
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
