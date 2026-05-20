import type { EntryMeta } from "@/features/editor/types";
import * as m from "@/paraglide/messages.js";

export function EntrySystemFields({ meta }: { meta: EntryMeta }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-1.5 gap-y-1 text-xs leading-5 text-muted-foreground">
      <span className="whitespace-nowrap">
        {m.entry_updated()}{" "}
        <time dateTime={meta.updated} title={formatFullDate(meta.updated)}>
          {formatShortDate(meta.updated)}
        </time>
      </span>
      <span aria-hidden="true">·</span>
      <span className="whitespace-nowrap">
        {m.entry_created()}{" "}
        <time dateTime={meta.created} title={formatFullDate(meta.created)}>
          {formatShortDate(meta.created)}
        </time>
      </span>
    </div>
  );
}

function formatShortDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  };
  if (date.getFullYear() !== new Date().getFullYear()) {
    options.year = "numeric";
  }
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function formatFullDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}
