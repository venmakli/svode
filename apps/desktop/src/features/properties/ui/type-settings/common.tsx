import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

export type ColumnSelectOption =
  | string
  | {
      value: string;
      label: string;
      description?: string | null;
    };

export function deferStateUpdate(update: () => void) {
  let cancelled = false;
  queueMicrotask(() => {
    if (!cancelled) update();
  });
  return () => {
    cancelled = true;
  };
}

export function ColumnSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ColumnSelectOption[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="w-20 text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8 flex-1">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => {
              const normalized = normalizeColumnSelectOption(option);
              return (
                <SelectItem key={normalized.value} value={normalized.value}>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{normalized.label}</span>
                    {normalized.description ? (
                      <span className="truncate text-xs text-muted-foreground">
                        {normalized.description}
                      </span>
                    ) : null}
                  </span>
                </SelectItem>
              );
            })}
          </SelectGroup>
        </SelectContent>
      </Select>
    </label>
  );
}

export function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-sm">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

function normalizeColumnSelectOption(option: ColumnSelectOption) {
  if (typeof option === "string") {
    return { value: option, label: option, description: null };
  }
  return option;
}
