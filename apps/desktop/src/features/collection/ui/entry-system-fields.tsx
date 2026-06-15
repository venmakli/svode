import type { EntryMeta } from "@/features/entry";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import * as m from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";

export function EntrySystemFields({ meta }: { meta: EntryMeta }) {
  const locale = getLocale();
  const updated = formatShortDate(meta.updated, locale);
  const created = formatShortDate(meta.created, locale);
  const tooltip = `${m.entry_updated()} ${updated} · ${m.entry_created()} ${created}`;

  return (
    <div className="flex flex-wrap items-center justify-end gap-x-1.5 gap-y-1 text-xs leading-5 text-muted-foreground">
      <Tooltip>
        <TooltipTrigger asChild>
          <time
            className="whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            dateTime={meta.updated}
            aria-label={tooltip}
            tabIndex={0}
          >
            {formatUpdatedPrefix(locale)} {updated}
          </time>
        </TooltipTrigger>
        <TooltipContent side="bottom">{tooltip}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function formatShortDate(value: string, locale: "en" | "ru") {
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
  return new Intl.DateTimeFormat(locale, options).format(date);
}

function formatUpdatedPrefix(locale: "en" | "ru") {
  return locale === "ru" ? "обн." : "upd.";
}
