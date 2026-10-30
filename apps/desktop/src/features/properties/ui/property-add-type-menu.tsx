import { useState, type ReactNode } from "react";
import {
  MultiPanePopover,
  type MultiPaneDefinition,
} from "@/shared/ui/multi-pane-popover";
import type { Column, PropertyType } from "../model/types";
import { propertyTypeAddUnavailableReason } from "./property-type-meta";
import { PropertyTypeMenuPane } from "./schema-column-menu";
import * as m from "@/paraglide/messages.js";

/** The pane every entrypoint uses to choose the type of a new property. */
export function propertyAddTypePane<TPane extends string>({
  id,
  columns,
  disabled,
  onSelect,
}: {
  id: TPane;
  columns: readonly Column[];
  disabled?: boolean;
  onSelect: (type: PropertyType) => void;
}): MultiPaneDefinition<TPane> {
  return {
    id,
    title: m.table_property_type_title(),
    content: (
      <PropertyTypeMenuPane
        disabled={disabled}
        unavailableReason={(type) =>
          propertyTypeAddUnavailableReason(columns, type)
        }
        onSelect={onSelect}
      />
    ),
    notice: m.property_add_type_notice(),
  };
}

/** A popover of its own with the add-type pane, closed once a type is chosen. */
export function PropertyAddTypeMenu({
  trigger,
  columns,
  align = "end",
  onSelect,
}: {
  trigger: ReactNode;
  columns: readonly Column[];
  align?: "start" | "center" | "end";
  onSelect: (type: PropertyType) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <MultiPanePopover
      open={open}
      onOpenChange={setOpen}
      trigger={trigger}
      mainPane="type"
      mainPaneHeader
      align={align}
      className="w-80 max-w-[calc(100vw-2rem)]"
      panes={[
        propertyAddTypePane({
          id: "type",
          columns,
          onSelect: (type) => {
            setOpen(false);
            onSelect(type);
          },
        }),
      ]}
    />
  );
}
