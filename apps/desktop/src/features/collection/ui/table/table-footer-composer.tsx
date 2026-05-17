import type { RefObject } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  TableCell,
  TableFooter,
  TableRow as ShadcnTableRow,
} from "@/components/ui/table";
import * as m from "@/paraglide/messages.js";

export function TableFooterComposer({
  colSpan,
  entryCount,
  footerRef,
  inputRef,
  open,
  value,
  onOpen,
  onCancel,
  onValueChange,
  onCreate,
}: {
  colSpan: number;
  entryCount: number;
  footerRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  open: boolean;
  value: string;
  onOpen: (asFolder: boolean) => void;
  onCancel: () => void;
  onValueChange: (value: string) => void;
  onCreate: (asFolder: boolean) => void;
}) {
  return (
    <TableFooter className="bg-background">
      <ShadcnTableRow className="h-10 hover:bg-background">
        <TableCell colSpan={colSpan} className="p-0">
          <div ref={footerRef} className="flex h-10 items-center gap-2 px-3">
            {open ? (
              <Input
                ref={inputRef}
                value={value}
                placeholder={m.table_new_entry_placeholder()}
                className="h-7 max-w-sm"
                onChange={(event) => onValueChange(event.target.value)}
                onBlur={() => {
                  if (!value.trim()) onCancel();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    onValueChange("");
                    onCancel();
                  }
                  if (event.key === "Enter") onCreate(event.shiftKey);
                }}
              />
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-muted-foreground"
                onClick={(event) => onOpen(event.shiftKey)}
              >
                <Plus data-icon="inline-start" />
                {m.table_new_entry_placeholder()}
              </Button>
            )}
            <div className="ml-auto text-xs text-muted-foreground">
              {m.table_entries_count({ count: entryCount })}
            </div>
          </div>
        </TableCell>
      </ShadcnTableRow>
    </TableFooter>
  );
}
