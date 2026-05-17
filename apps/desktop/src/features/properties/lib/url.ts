export function normalizeUrlValue(value: unknown) {
  if (typeof value === "string") {
    return { href: value, title: fallbackUrlTitle(value) };
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const href = typeof record.href === "string" ? record.href : "";
    const title = typeof record.title === "string" ? record.title : "";
    return { href, title };
  }
  return { href: "", title: "" };
}

export function fallbackUrlTitle(href: string) {
  try {
    const url = new URL(href);
    return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return href.replace(/^https?:\/\//, "");
  }
}
