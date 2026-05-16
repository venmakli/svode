import { flexRender, type Table as ReactTable } from "@tanstack/react-table";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  TableHead,
  TableHeader,
  TableRow as ShadcnTableRow,
} from "@/components/ui/table";
import type { PropertyType } from "@/features/properties/types";
import { PropertyTypePicker } from "./property-type-picker";
import type { CollectionTableRow } from "./types";
import * as m from "@/paraglide/messages.js";

export function TableHeaderRow({
  table,
  onAddColumn,
}: {
  table: ReactTable<CollectionTableRow>;
  onAddColumn: (type: PropertyType) => void;
}) {
  return (
    <TableHeader className="sticky top-0 z-10 bg-muted/40">
      {table.getHeaderGroups().map((headerGroup) => (
        <ShadcnTableRow key={headerGroup.id} className="h-[34px]">
          <TableHead className="h-[34px] w-[18px] p-0" />
          {headerGroup.headers.map((header) => (
            <TableHead
              key={header.id}
              className="h-[34px] border-r p-0"
              style={{ width: header.getSize() }}
            >
              {flexRender(header.column.columnDef.header, header.getContext())}
            </TableHead>
          ))}
          <TableHead className="h-[34px] p-0">
            <PropertyTypePicker
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="h-[34px] w-11 rounded-none text-muted-foreground [&_svg]:size-3.5"
                >
                  <Plus />
                  <span className="sr-only">{m.collection_add_property()}</span>
                </Button>
              }
              onSelect={onAddColumn}
            />
          </TableHead>
        </ShadcnTableRow>
      ))}
    </TableHeader>
  );
}
