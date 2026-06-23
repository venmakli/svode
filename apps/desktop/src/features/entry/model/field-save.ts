import type { Entry } from "./types";

export const ENTRY_FIELD_TEXT_SAVE_DELAY_MS = 500;

export interface EntryFieldSavePolicy {
  mode: "debounced" | "immediate";
  delayMs?: number;
}

export type EntryFieldSaveMode = EntryFieldSavePolicy["mode"];

export function entryFieldSavePolicy(field: string): EntryFieldSavePolicy {
  return isEntryTextLikeField(field)
    ? { mode: "debounced", delayMs: ENTRY_FIELD_TEXT_SAVE_DELAY_MS }
    : { mode: "immediate" };
}

export function isEntryTextLikeField(field: string) {
  return field === "title" || field === "description";
}

export function isEntryTreeMetaField(field: string) {
  return field === "title" || field === "icon" || field === "description";
}

export function patchEntryField(
  entry: Entry,
  field: string,
  value: unknown,
): Entry {
  if (field === "title" && typeof value === "string") {
    return { ...entry, meta: { ...entry.meta, title: value } };
  }
  if (field === "icon") {
    return {
      ...entry,
      meta: { ...entry.meta, icon: typeof value === "string" ? value : null },
    };
  }
  if (field === "description") {
    return {
      ...entry,
      meta: {
        ...entry.meta,
        description: typeof value === "string" && value.trim() ? value : null,
      },
    };
  }
  if (field === "cover") {
    return { ...entry, meta: { ...entry.meta, cover: value as never } };
  }

  const extra = { ...entry.meta.extra };
  if (isClearedEntryFieldValue(value)) {
    delete extra[field];
  } else {
    extra[field] = value;
  }
  return { ...entry, meta: { ...entry.meta, extra } };
}

export function mergeSavedEntryField(
  current: Entry,
  field: string,
  saved: Entry,
): Entry {
  const nextMeta = {
    ...current.meta,
    updated: saved.meta.updated,
  };

  if (field === "title") {
    return { ...current, meta: { ...nextMeta, title: saved.meta.title } };
  }
  if (field === "icon") {
    return { ...current, meta: { ...nextMeta, icon: saved.meta.icon } };
  }
  if (field === "description") {
    return {
      ...current,
      meta: { ...nextMeta, description: saved.meta.description ?? null },
    };
  }
  if (field === "cover") {
    return { ...current, meta: { ...nextMeta, cover: saved.meta.cover ?? null } };
  }

  const extra = { ...current.meta.extra };
  if (Object.prototype.hasOwnProperty.call(saved.meta.extra, field)) {
    extra[field] = saved.meta.extra[field];
  } else {
    delete extra[field];
  }
  return { ...current, meta: { ...nextMeta, extra } };
}

export function rollbackEntryField(
  current: Entry,
  field: string,
  previous: Entry,
): Entry {
  return mergeSavedEntryField(current, field, {
    ...previous,
    meta: { ...previous.meta, updated: current.meta.updated },
  });
}

export function isClearedEntryFieldValue(value: unknown) {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}
