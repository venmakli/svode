import type { Page } from "./types";

export const PAGE_FIELD_TEXT_SAVE_DELAY_MS = 500;

export interface PageFieldSavePolicy {
  mode: "debounced" | "immediate";
  delayMs?: number;
}

export type PageFieldSaveMode = PageFieldSavePolicy["mode"];

export function pageFieldSavePolicy(field: string): PageFieldSavePolicy {
  return isPageTextLikeField(field)
    ? { mode: "debounced", delayMs: PAGE_FIELD_TEXT_SAVE_DELAY_MS }
    : { mode: "immediate" };
}

export function isPageTextLikeField(field: string) {
  return field === "title" || field === "description";
}

export function isPageTreeMetaField(field: string) {
  return field === "title" || field === "icon" || field === "description";
}

export function patchPageField(
  page: Page,
  field: string,
  value: unknown,
): Page {
  if (field === "title" && typeof value === "string") {
    return { ...page, meta: { ...page.meta, title: value } };
  }
  if (field === "icon") {
    return {
      ...page,
      meta: { ...page.meta, icon: typeof value === "string" ? value : null },
    };
  }
  if (field === "description") {
    return {
      ...page,
      meta: {
        ...page.meta,
        description: typeof value === "string" && value.trim() ? value : null,
      },
    };
  }
  if (field === "cover") {
    return { ...page, meta: { ...page.meta, cover: value as never } };
  }

  const extra = { ...page.meta.extra };
  if (isClearedPageFieldValue(value)) {
    delete extra[field];
  } else {
    extra[field] = value;
  }
  return { ...page, meta: { ...page.meta, extra } };
}

export function mergeSavedPageField(
  current: Page,
  field: string,
  saved: Page,
): Page {
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

export function mergeSavedPageFieldResult(
  current: Page,
  field: string,
  saved: Page,
  preserveCurrentPath: boolean,
): Page {
  const merged = mergeSavedPageField(current, field, saved);
  return preserveCurrentPath || saved.path === current.path
    ? merged
    : { ...merged, path: saved.path };
}

export function rollbackPageField(
  current: Page,
  field: string,
  previous: Page,
): Page {
  return mergeSavedPageField(current, field, {
    ...previous,
    meta: { ...previous.meta, updated: current.meta.updated },
  });
}

export function isClearedPageFieldValue(value: unknown) {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}
