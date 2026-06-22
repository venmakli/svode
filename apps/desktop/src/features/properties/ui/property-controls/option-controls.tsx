import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/shared/lib/utils";
import { hasOption, optionByName, STATUS_GROUPS } from "../../lib/utils";
import { PropertyBadge } from "../property-badge";
import * as m from "@/paraglide/messages.js";
import { OptionDot, useAutoOpen } from "./common";
import type { PropertyControlProps } from "./types";

export function SelectControl({
  column,
  value,
  invalid,
  disabled,
  autoOpen,
  onChange,
  onOpenChange,
}: PropertyControlProps) {
  const [open, setOpen] = useAutoOpen(autoOpen, onOpenChange);
  const selected = optionByName(column, value);
  const invalidOption = typeof value === "string" && value && !selected;
  const triggerOption =
    selected ??
    (typeof value === "string" && value
      ? { name: value, color: "neutral" as const }
      : null);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled}
          className={cn(
            "min-w-0 justify-start px-1.5",
            (invalid || invalidOption) && "ring-1 ring-warning",
          )}
        >
          {triggerOption ? (
            <PropertyBadge
              option={triggerOption}
              invalid={invalidOption || invalid}
            />
          ) : (
            <span className="text-muted-foreground">{m.property_empty()}</span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-44">
        <DropdownMenuGroup>
          {column.options?.map((option) => (
            <DropdownMenuItem
              key={option.name}
              onSelect={() => void onChange(option.name)}
            >
              <OptionDot option={option} />
              <span className="min-w-0 flex-1 truncate">
                {option.icon ? `${option.icon} ` : ""}
                {option.name}
              </span>
              {option.name === value ? <Check data-icon="inline-end" /> : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void onChange(null)}>
            {m.property_action_clear()}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function StatusControl({
  column,
  value,
  invalid,
  disabled,
  autoOpen,
  onChange,
  onOpenChange,
}: PropertyControlProps) {
  const [open, setOpen] = useAutoOpen(autoOpen, onOpenChange);
  const selected = optionByName(column, value);
  const invalidOption = typeof value === "string" && value && !selected;
  const triggerOption =
    selected ??
    (typeof value === "string" && value
      ? { name: value, color: "neutral" as const }
      : null);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled}
          className={cn(
            "min-w-0 justify-start px-1.5",
            (invalid || invalidOption) && "ring-1 ring-warning",
          )}
        >
          {triggerOption ? (
            <PropertyBadge
              option={triggerOption}
              invalid={invalidOption || invalid}
            />
          ) : (
            <span className="text-muted-foreground">{m.property_empty()}</span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-52">
        {STATUS_GROUPS.map((group, index) => (
          <DropdownMenuGroup key={group.value}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
            {(column.options ?? [])
              .filter((option) => option.group === group.value)
              .map((option) => (
                <DropdownMenuItem
                  key={option.name}
                  onSelect={() => void onChange(option.name)}
                >
                  <OptionDot option={option} />
                  <span className="min-w-0 flex-1 truncate">
                    {option.icon ? `${option.icon} ` : ""}
                    {option.name}
                  </span>
                  {option.name === value ? (
                    <Check data-icon="inline-end" />
                  ) : null}
                </DropdownMenuItem>
              ))}
          </DropdownMenuGroup>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void onChange(null)}>
          {m.property_action_clear()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MultiSelectControl({
  column,
  value,
  invalid,
  disabled,
  autoOpen,
  onChange,
  onOpenChange,
}: PropertyControlProps) {
  const [open, setOpen] = useAutoOpen(autoOpen, onOpenChange);
  const values = Array.isArray(value)
    ? value.filter((item) => typeof item === "string")
    : [];
  const selected = values.map((name) => {
    return (
      column.options?.find((option) => option.name === name) ?? {
        name,
        color: "neutral" as const,
      }
    );
  });
  const selectedSet = new Set(values);

  const remove = (name: string) => {
    void onChange(values.filter((item) => item !== name));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled || undefined}
          className={cn(
            "flex h-auto min-h-8 min-w-0 cursor-default items-center justify-start rounded-lg px-1.5 py-1 text-sm outline-none transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
            invalid && "ring-1 ring-warning",
          )}
        >
          <div className="flex min-w-0 flex-wrap gap-1">
            {selected.length > 0 ? (
              selected.map((option) => (
                <PropertyBadge
                  key={option.name}
                  option={option}
                  invalid={!hasOption(column, option.name)}
                  onRemove={() => remove(option.name)}
                />
              ))
            ) : (
              <span className="text-muted-foreground">
                {m.property_empty()}
              </span>
            )}
          </div>
        </div>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder={m.property_search_options()} />
          <CommandList>
            <CommandEmpty>{m.property_no_options()}</CommandEmpty>
            <CommandGroup>
              {column.options?.map((option) => (
                <CommandItem
                  key={option.name}
                  data-checked={selectedSet.has(option.name)}
                  onSelect={() => {
                    const next = selectedSet.has(option.name)
                      ? values.filter((item) => item !== option.name)
                      : [...values, option.name];
                    void onChange(next);
                  }}
                >
                  <OptionDot option={option} />
                  <span className="min-w-0 flex-1 truncate">
                    {option.icon ? `${option.icon} ` : ""}
                    {option.name}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
