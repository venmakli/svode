import { useState, type ReactNode } from "react";
import { ArrowLeft, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { PropertyType } from "@/features/properties/model";
import { PROPERTY_TYPES } from "@/features/properties/lib";
import { PROPERTY_TYPE_ICONS } from "./icons";
import * as m from "@/paraglide/messages.js";

export function PropertyTypePicker({
  trigger,
  activeType,
  onSelect,
}: {
  trigger: ReactNode;
  activeType?: PropertyType;
  onSelect: (type: PropertyType) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" className="w-[260px] overflow-hidden p-0">
        <div className="flex h-11 items-center gap-2 border-b px-3">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => setOpen(false)}
          >
            <ArrowLeft data-icon="inline-start" />
            <span className="sr-only">{m.settings_cancel()}</span>
          </Button>
          <div className="text-sm font-semibold">
            {m.table_property_type_title()}
          </div>
        </div>
        <div className="p-1">
          {PROPERTY_TYPES.map((type) => {
            const Icon = PROPERTY_TYPE_ICONS[type.value];
            return (
              <Button
                key={type.value}
                type="button"
                variant="ghost"
                className="h-9 w-full justify-start gap-3 rounded-lg px-3 text-sm font-normal"
                onClick={() => {
                  onSelect(type.value);
                  setOpen(false);
                }}
              >
                <Icon data-icon="inline-start" />
                <span className="flex-1 text-left">
                  {propertyTypeLabel(type.value)}
                </span>
                {activeType === type.value ? (
                  <Check data-icon="inline-end" />
                ) : null}
              </Button>
            );
          })}
        </div>
        <div className="border-t px-3 py-2 text-xs leading-5 text-muted-foreground">
          {m.table_property_type_notice()}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function propertyTypeLabel(type: PropertyType) {
  const labels: Record<PropertyType, string> = {
    text: String(m.table_property_type_text()),
    number: String(m.table_property_type_number()),
    select: String(m.table_property_type_select()),
    multi_select: String(m.table_property_type_multi_select()),
    status: String(m.table_property_type_status()),
    date: String(m.table_property_type_date()),
    person: String(m.table_property_type_person()),
    checkbox: String(m.table_property_type_checkbox()),
    url: String(m.table_property_type_url()),
    email: String(m.table_property_type_email()),
    phone: String(m.table_property_type_phone()),
    relation: String(m.table_property_type_relation()),
  };
  return labels[type];
}
