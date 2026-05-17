import { Plus, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { SettingsRow } from "./settings-row";

export function QuerySettingsPane({
  items,
  empty,
  icon: Icon,
}: {
  items: unknown[];
  empty: string;
  icon: LucideIcon;
}) {
  if (items.length === 0) {
    return (
      <Empty className="min-h-48 border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon />
          </EmptyMedia>
          <EmptyTitle>{empty}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col p-1">
      {items.map((item, index) => {
        const row = item as { field?: string; op?: string; desc?: boolean };
        return (
          <SettingsRow
            key={index}
            icon={Icon}
            label={row.field ?? "-"}
            meta={row.op ?? (row.desc ? "desc" : "asc")}
            right={null}
          />
        );
      })}
    </div>
  );
}

export function QueryAddButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="default"
      className="h-9 w-full justify-start px-2 text-sm font-normal"
      onClick={onClick}
    >
      <Plus data-icon="inline-start" />
      {label}
    </Button>
  );
}
