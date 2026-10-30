import type { ReactElement } from "react";
import { CircleFadingArrowUp } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { isEmptyValue, newerValueText } from "../lib/utils";
import type { Column } from "../model/types";
import * as m from "@/paraglide/messages.js";

/** Stands for the type of a property a newer Svode version set. */
export const NEWER_PROPERTY_ICON = CircleFadingArrowUp;

/** The value of a property of a newer version: text, without an editor. */
export function NewerPropertyValue({ value }: { value: unknown }) {
  if (isEmptyValue(value)) {
    return <span className="text-muted-foreground">-</span>;
  }
  return <span data-newer-property-value>{newerValueText(value)}</span>;
}

/** Explains on hover and focus why the property cannot be changed. */
export function NewerPropertyHint({ children }: { children: ReactElement }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="max-w-64">
          {m.property_newer_hint()}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** The label of a property of a newer version where others open their menu. */
export function NewerPropertyLabel({ column }: { column: Column }) {
  return (
    <NewerPropertyHint>
      <span
        tabIndex={0}
        aria-label={`${column.name}: ${m.property_newer_hint()}`}
        data-newer-property={column.name}
        className="flex h-8 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <NEWER_PROPERTY_ICON aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{column.name}</span>
      </span>
    </NewerPropertyHint>
  );
}
