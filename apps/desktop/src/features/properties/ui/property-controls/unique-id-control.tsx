import { Copy } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import {
  uniqueIdDisplay,
  uniqueIdRawDisplay,
} from "../../lib/utils";
import * as m from "@/paraglide/messages.js";
import { copyPropertyValue, IconAction } from "./common";
import type { PropertyControlProps } from "./types";

export function UniqueIdControl({
  column,
  value,
  invalid,
}: Pick<PropertyControlProps, "column" | "value" | "invalid">) {
  const display = uniqueIdDisplay(column, value);
  const raw = uniqueIdRawDisplay(value);
  const label = display || raw || m.property_state_no_key();
  return (
    <div
      className={cn(
        "group/control flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-transparent px-1.5 text-sm",
        invalid && "border-warning",
      )}
    >
      <span
        className={cn(
          "min-w-0 truncate rounded-full bg-muted px-2 py-0.5 font-mono text-xs text-foreground",
          !display && "font-sans text-muted-foreground",
        )}
      >
        {label}
      </span>
      <IconAction
        label={m.property_action_copy()}
        className="opacity-0 group-focus-within/control:opacity-100 group-hover/control:opacity-100"
        onClick={() => copyPropertyValue(display || raw)}
        disabled={!display && !raw}
      >
        <Copy />
      </IconAction>
    </div>
  );
}
