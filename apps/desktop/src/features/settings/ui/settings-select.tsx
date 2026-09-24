import { LoaderCircle } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/shared/lib/utils";

export interface SettingsSelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function SettingsSelect({
  id,
  value,
  options,
  onValueChange,
  disabled = false,
  pending = false,
  className,
}: {
  id?: string;
  value: string;
  options: readonly SettingsSelectOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  pending?: boolean;
  className?: string;
}) {
  const selected = options.find((option) => option.value === value);
  const described = options.some((option) => option.description);
  return (
    <Select
      value={value}
      onValueChange={onValueChange}
      disabled={disabled || pending}
    >
      <SelectTrigger
        id={id}
        aria-busy={pending || undefined}
        className={cn("w-44 max-w-full", className)}
      >
        <SelectValue>{selected?.label}</SelectValue>
        {pending ? (
          <LoaderCircle
            aria-hidden
            className="ml-auto animate-spin text-muted-foreground"
          />
        ) : null}
      </SelectTrigger>
      <SelectContent
        position="popper"
        align="end"
        className={cn(described && "w-72")}
      >
        <SelectGroup>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={option.disabled}
              textValue={option.label}
            >
              {option.description ? (
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>{option.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {option.description}
                  </span>
                </span>
              ) : (
                option.label
              )}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
