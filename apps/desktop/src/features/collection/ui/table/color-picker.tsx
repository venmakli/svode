import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { ColorName } from "@/features/properties/model";
import { COLOR_NAMES, colorStyle } from "@/features/properties/lib";

export function ColorPicker({
  value,
  compact,
  onChange,
}: {
  value: ColorName;
  compact?: boolean;
  onChange: (color: ColorName) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "size-4 rounded-full bg-[var(--property-color)] ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            !compact && "size-5",
          )}
          style={colorStyle(value)}
        >
          <span className="sr-only">{value}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-32 p-2">
        <div className="grid grid-cols-5 gap-2">
          {COLOR_NAMES.map((color) => (
            <button
              key={color}
              type="button"
              className={cn(
                "size-4 rounded-full bg-[var(--property-color)] ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                value === color && "ring-2 ring-ring",
              )}
              style={colorStyle(color)}
              onClick={() => onChange(color)}
            >
              <span className="sr-only">{color}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
