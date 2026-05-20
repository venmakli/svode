import { cn } from "@/lib/utils";
import type { EntryMeta } from "@/features/editor/types";
import * as m from "@/paraglide/messages.js";

export function EntrySystemFields({
  meta,
  mode = "peek",
}: {
  meta: EntryMeta;
  mode?: "peek" | "full";
}) {
  return (
    <div
      className={cn(
        "grid gap-x-6 gap-y-2 border-t pt-3 text-sm text-muted-foreground",
        mode === "full"
          ? "grid-cols-[minmax(7rem,12rem)_minmax(0,1fr)] md:grid-cols-[minmax(7rem,12rem)_minmax(0,1fr)_minmax(7rem,12rem)_minmax(0,1fr)]"
          : "grid-cols-[minmax(7rem,12rem)_minmax(0,1fr)]",
      )}
    >
      <span>{m.entry_created()}</span>
      <span className="truncate">{formatDate(meta.created)}</span>
      <span>{m.entry_updated()}</span>
      <span className="truncate">{formatDate(meta.updated)}</span>
    </div>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
