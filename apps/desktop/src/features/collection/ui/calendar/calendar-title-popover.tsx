import { useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import type { CalendarCreateDraft } from "../../model/calendar-types";
import * as m from "@/paraglide/messages.js";

export function CalendarTitlePopover({
  draft,
  onCancel,
  onCreate,
}: {
  draft: CalendarCreateDraft | null;
  onCancel: () => void;
  onCreate: (title: string, draft: CalendarCreateDraft) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!draft) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [draft]);

  function commit() {
    if (!draft) return;
    const trimmed = inputRef.current?.value.trim() ?? "";
    if (!trimmed) {
      onCancel();
      return;
    }
    onCreate(trimmed, draft);
  }

  return (
    <Popover open={Boolean(draft)} onOpenChange={(open) => !open && onCancel()}>
      {draft ? (
        <PopoverAnchor asChild>
          <span
            className="fixed size-1"
            style={{ left: draft.anchor.x, top: draft.anchor.y }}
          />
        </PopoverAnchor>
      ) : null}
      <PopoverContent align="start" side="bottom" className="w-72 p-2">
        <Input
          key={
            draft
              ? `${draft.anchor.x}:${draft.anchor.y}:${JSON.stringify(draft.dateValue)}`
              : "closed"
          }
          ref={inputRef}
          defaultValue=""
          placeholder={m.calendar_new_entry_placeholder()}
          onBlur={() => {
            if (!inputRef.current?.value.trim()) onCancel();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
