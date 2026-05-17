import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  TableBody,
  TableCell,
  TableRow as ShadcnTableRow,
} from "@/components/ui/table";
import * as m from "@/paraglide/messages.js";

export function EmptyTableBody({
  colSpan,
  filtered,
  onCreate,
  onClearFilters,
}: {
  colSpan: number;
  filtered: boolean;
  onCreate: () => void;
  onClearFilters: () => void;
}) {
  return (
    <TableBody>
      <ShadcnTableRow>
        <TableCell colSpan={colSpan} className="p-0">
          <Empty className="min-h-48 border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileText />
              </EmptyMedia>
              <EmptyTitle>
                {filtered ? m.table_no_results() : m.table_empty()}
              </EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
              <Button
                type="button"
                variant={filtered ? "outline" : "default"}
                size="sm"
                onClick={filtered ? onClearFilters : onCreate}
              >
                {filtered
                  ? m.table_clear_filters()
                  : m.table_create_first_entry()}
              </Button>
            </EmptyContent>
          </Empty>
        </TableCell>
      </ShadcnTableRow>
    </TableBody>
  );
}
