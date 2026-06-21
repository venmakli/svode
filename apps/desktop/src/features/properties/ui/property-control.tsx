import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import {
  Check,
  Copy,
  ExternalLink,
  Link,
  Mail,
  PhoneCall,
  Text,
  X,
} from "lucide-react";
import type {
  Column,
  DateRangeValue,
  ActorCandidate,
  PropertyOption,
  RelationContext,
} from "../model/types";
import { RelationControl } from "./relation-control";
import { PropertyBadge } from "./property-badge";
import {
  resolveActorCandidate,
  STATUS_GROUPS,
  colorStyle,
  formatDateValue,
  gravatarUrl,
  hashIndex,
  hasOption,
  initialsForActor,
  isEmptyValue,
  isValidEmail,
  isValidPhone,
  isValidUrl,
  normalizeDateInput,
  normalizeActorValues,
  optionByName,
  optionColor,
  actorCommitCount,
  actorDisplayName,
  actorIsMe,
  actorLastCommitAt,
  todayIsoDate,
  uniqueIdDisplay,
  uniqueIdRawDisplay,
  valueToString,
} from "../lib/utils";
import { fallbackUrlTitle, normalizeUrlValue } from "../lib/url";
import * as m from "@/paraglide/messages.js";

function deferStateUpdate(update: () => void) {
  let cancelled = false;
  queueMicrotask(() => {
    if (!cancelled) update();
  });
  return () => {
    cancelled = true;
  };
}

interface PropertyControlProps {
  column: Column;
  value: unknown;
  invalid?: boolean;
  disabled?: boolean;
  autoOpen?: boolean;
  actors?: ActorCandidate[];
  relationContext?: RelationContext;
  onRequestActors?: (allTime: boolean) => Promise<ActorCandidate[]>;
  onChange: (value: unknown) => void | Promise<void>;
  onOpenChange?: (open: boolean) => void;
}

export function PropertyControl({
  column,
  value,
  invalid,
  disabled,
  autoOpen,
  actors = [],
  relationContext,
  onRequestActors,
  onChange,
  onOpenChange,
}: PropertyControlProps) {
  switch (column.type) {
    case "number":
      return (
        <NumberControl
          column={column}
          value={value}
          invalid={invalid}
          disabled={disabled}
          autoOpen={autoOpen}
          onChange={onChange}
          onOpenChange={onOpenChange}
        />
      );
    case "select":
      return (
        <SelectControl
          column={column}
          value={value}
          invalid={invalid}
          disabled={disabled}
          autoOpen={autoOpen}
          onChange={onChange}
          onOpenChange={onOpenChange}
        />
      );
    case "multi_select":
      return (
        <MultiSelectControl
          column={column}
          value={value}
          invalid={invalid}
          disabled={disabled}
          autoOpen={autoOpen}
          onChange={onChange}
          onOpenChange={onOpenChange}
        />
      );
    case "status":
      return (
        <StatusControl
          column={column}
          value={value}
          invalid={invalid}
          disabled={disabled}
          autoOpen={autoOpen}
          onChange={onChange}
          onOpenChange={onOpenChange}
        />
      );
    case "date":
      return (
        <DateControl
          column={column}
          value={value}
          invalid={invalid}
          disabled={disabled}
          autoOpen={autoOpen}
          onChange={onChange}
          onOpenChange={onOpenChange}
        />
      );
    case "unique_id":
      return (
        <UniqueIdControl column={column} value={value} invalid={invalid} />
      );
    case "actor":
      return (
        <ActorControl
          column={column}
          value={value}
          invalid={invalid}
          disabled={disabled}
          autoOpen={autoOpen}
          actors={actors}
          onRequestActors={onRequestActors}
          onChange={onChange}
          onOpenChange={onOpenChange}
        />
      );
    case "relation":
      return (
        <RelationControl
          column={column}
          value={value}
          invalid={invalid}
          disabled={disabled}
          autoOpen={autoOpen}
          context={relationContext}
          onChange={onChange}
          onOpenChange={onOpenChange}
        />
      );
    case "checkbox":
      return (
        <Checkbox
          checked={Boolean(value)}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          onCheckedChange={(checked) => {
            void onChange(checked === true);
          }}
        />
      );
    case "url":
      return (
        <UrlControl
          value={value}
          invalid={invalid}
          disabled={disabled}
          autoOpen={autoOpen}
          onChange={onChange}
          onOpenChange={onOpenChange}
        />
      );
    case "email":
      return (
        <EmailControl
          value={value}
          invalid={invalid}
          disabled={disabled}
          autoOpen={autoOpen}
          onChange={onChange}
        />
      );
    case "phone":
      return (
        <PhoneControl
          value={value}
          invalid={invalid}
          disabled={disabled}
          autoOpen={autoOpen}
          onChange={onChange}
        />
      );
    case "text":
    default:
      return (
        <TextControl
          value={value}
          invalid={invalid}
          disabled={disabled}
          onChange={onChange}
        />
      );
  }
}

function TextControl({
  value,
  invalid,
  disabled,
  onChange,
}: Pick<PropertyControlProps, "value" | "invalid" | "disabled" | "onChange">) {
  const [draft, setDraft] = useState(valueToString(value));
  useEffect(
    () => deferStateUpdate(() => setDraft(valueToString(value))),
    [value],
  );
  return (
    <div className="group/control relative">
      <Input
        value={draft}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void onChange(draft || null)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
        className="pr-8"
      />
      <IconAction
        label={m.property_action_copy()}
        className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-focus-within/control:opacity-100 group-hover/control:opacity-100"
        onClick={() => copyValue(draft)}
        disabled={!draft}
      >
        <Copy />
      </IconAction>
    </div>
  );
}

function NumberControl({
  column,
  value,
  invalid,
  disabled,
  onChange,
}: PropertyControlProps) {
  const display = column.display ?? "number";
  const [draft, setDraft] = useState(valueToString(value));
  useEffect(
    () => deferStateUpdate(() => setDraft(valueToString(value))),
    [value],
  );
  const numeric = typeof value === "number" ? value : Number(draft);
  const min = column.min ?? 0;
  const max = column.max ?? 100;
  const ratio = max === min ? 0 : ((numeric - min) / (max - min)) * 100;
  const clamped = Number.isFinite(ratio)
    ? Math.min(100, Math.max(0, ratio))
    : 0;
  const outOfRange =
    Number.isFinite(numeric) && (numeric < min || numeric > max);

  if (display === "bar" || display === "ring") {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex min-w-0 items-center gap-2">
              <InlineNumberInput
                draft={draft}
                invalid={invalid}
                disabled={disabled}
                onDraftChange={setDraft}
                onCommit={() => commitNumber(draft, onChange)}
              />
              {display === "bar" ? (
                <Progress
                  value={clamped}
                  className="min-w-20 flex-1 **:data-[slot=progress-indicator]:bg-(--property-color)"
                  style={colorStyle(column.color ?? "blue")}
                />
              ) : (
                <RingProgress value={clamped} color={column.color ?? "blue"} />
              )}
            </div>
          </TooltipTrigger>
          {outOfRange ? (
            <TooltipContent>
              {m.property_number_exact_value({ value: String(numeric) })}
            </TooltipContent>
          ) : null}
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (display === "percent") {
    const percent = max === 0 ? numeric : (numeric / max) * 100;
    return (
      <div className="flex items-center gap-2">
        <InlineNumberInput
          draft={draft}
          invalid={invalid}
          disabled={disabled}
          onDraftChange={setDraft}
          onCommit={() => commitNumber(draft, onChange)}
        />
        <span className="w-14 shrink-0 text-right text-sm text-muted-foreground">
          {Number.isFinite(percent) ? `${Math.round(percent)}%` : ""}
        </span>
      </div>
    );
  }

  return (
    <InlineNumberInput
      draft={draft}
      invalid={invalid}
      disabled={disabled}
      onDraftChange={setDraft}
      onCommit={() => commitNumber(draft, onChange)}
    />
  );
}

function InlineNumberInput({
  draft,
  invalid,
  disabled,
  onDraftChange,
  onCommit,
}: {
  draft: string;
  invalid?: boolean;
  disabled?: boolean;
  onDraftChange: (value: string) => void;
  onCommit: () => void;
}) {
  return (
    <Input
      type="number"
      value={draft}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      onChange={(event) => onDraftChange(event.target.value)}
      onBlur={onCommit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
      className="min-w-20"
    />
  );
}

function RingProgress({
  value,
  color,
}: {
  value: number;
  color: Column["color"];
}) {
  return (
    <div
      className="grid size-7 shrink-0 place-items-center rounded-full bg-(--property-ring-bg) text-[10px] font-medium text-muted-foreground"
      style={
        {
          ...colorStyle(color ?? "blue"),
          "--progress": `${value}%`,
          "--property-ring-bg":
            "conic-gradient(var(--property-color) var(--progress), var(--muted) 0)",
        } as CSSProperties
      }
    >
      <div className="grid size-5 place-items-center rounded-full bg-background">
        {Math.round(value)}
      </div>
    </div>
  );
}

function SelectControl({
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

function StatusControl({
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

function MultiSelectControl({
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

function DateControl({
  column,
  value,
  invalid,
  disabled,
  autoOpen,
  onChange,
  onOpenChange,
}: PropertyControlProps) {
  const [open, setOpen] = useAutoOpen(autoOpen, onOpenChange);
  const normalized = normalizeDateInput(value);
  const [startDate, setStartDate] = useState(datePart(normalized.start));
  const [startTime, setStartTime] = useState(timePart(normalized.start));
  const [endDate, setEndDate] = useState(datePart(normalized.end));
  const [endTime, setEndTime] = useState(timePart(normalized.end));
  const [hasTime, setHasTime] = useState(
    normalized.hasTime || Boolean(column.timeByDefault),
  );
  const [isRange, setIsRange] = useState(
    normalized.isRange || Boolean(column.rangeByDefault),
  );

  useEffect(() => {
    return deferStateUpdate(() => {
      const next = normalizeDateInput(value);
      setStartDate(datePart(next.start));
      setStartTime(timePart(next.start));
      setEndDate(datePart(next.end));
      setEndTime(timePart(next.end));
      setHasTime(
        next.hasTime || (isEmptyValue(value) && Boolean(column.timeByDefault)),
      );
      setIsRange(
        next.isRange || (isEmptyValue(value) && Boolean(column.rangeByDefault)),
      );
    });
  }, [column.rangeByDefault, column.timeByDefault, value]);

  const apply = (
    next?: Partial<{
      startDate: string;
      startTime: string;
      endDate: string;
      endTime: string;
      hasTime: boolean;
      isRange: boolean;
    }>,
  ) => {
    const nextStartDate = next?.startDate ?? startDate;
    const nextStartTime = next?.startTime ?? startTime;
    const nextEndDate = next?.endDate ?? endDate;
    const nextEndTime = next?.endTime ?? endTime;
    const nextHasTime = next?.hasTime ?? hasTime;
    const nextIsRange = next?.isRange ?? isRange;
    if (!nextStartDate) {
      void onChange(null);
      return;
    }
    const start = combineDateTime(nextStartDate, nextStartTime, nextHasTime);
    if (!nextIsRange) {
      void onChange(start);
      return;
    }
    const end = combineDateTime(
      nextEndDate || nextStartDate,
      nextEndTime || nextStartTime,
      nextHasTime,
    );
    void onChange({ start, end } satisfies DateRangeValue);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn(
            "w-full min-w-0 justify-start",
            invalid && "border-warning",
          )}
        >
          <span className="truncate">
            {formatDateValue(value, column.display) || m.property_empty()}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <div className="flex flex-col gap-2.5">
          <div className="grid grid-cols-[1fr_auto] items-center gap-2">
            <Input
              type="date"
              value={startDate}
              onChange={(event) => {
                setStartDate(event.target.value);
                apply({ startDate: event.target.value });
              }}
            />
            {hasTime ? (
              <Input
                type="time"
                value={startTime}
                onChange={(event) => {
                  setStartTime(event.target.value);
                  apply({ startTime: event.target.value });
                }}
                className="w-28"
              />
            ) : null}
          </div>
          {isRange ? (
            <div className="grid grid-cols-[1fr_auto] items-center gap-2">
              <Input
                type="date"
                value={endDate}
                onChange={(event) => {
                  setEndDate(event.target.value);
                  apply({ endDate: event.target.value });
                }}
              />
              {hasTime ? (
                <Input
                  type="time"
                  value={endTime}
                  onChange={(event) => {
                    setEndTime(event.target.value);
                    apply({ endTime: event.target.value });
                  }}
                  className="w-28"
                />
              ) : null}
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-muted-foreground">
              {m.property_date_time()}
            </span>
            <Switch
              checked={hasTime}
              onCheckedChange={(checked) => {
                setHasTime(checked);
                apply({ hasTime: checked });
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-muted-foreground">
              {m.property_date_range()}
            </span>
            <Switch
              checked={isRange}
              onCheckedChange={(checked) => {
                setIsRange(checked);
                apply({ isRange: checked, endDate: endDate || startDate });
              }}
            />
          </div>
          <div className="flex gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const next = todayIsoDate();
                setStartDate(next);
                setEndDate(next);
                apply({ startDate: next, endDate: next });
              }}
            >
              {m.property_date_today()}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const next = todayIsoDate(1);
                setStartDate(next);
                setEndDate(next);
                apply({ startDate: next, endDate: next });
              }}
            >
              {m.property_date_tomorrow()}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setStartDate("");
                setEndDate("");
                void onChange(null);
              }}
            >
              {m.property_action_clear()}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function UniqueIdControl({
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
        onClick={() => copyValue(display || raw)}
        disabled={!display && !raw}
      >
        <Copy />
      </IconAction>
    </div>
  );
}

function ActorControl({
  column,
  value,
  invalid,
  disabled,
  autoOpen,
  actors = [],
  onRequestActors,
  onChange,
  onOpenChange,
}: Pick<
  PropertyControlProps,
  | "value"
  | "invalid"
  | "disabled"
  | "actors"
  | "onRequestActors"
  | "onChange"
  | "autoOpen"
  | "onOpenChange"
> & { column: Column }) {
  const [open, setOpen] = useAutoOpen(autoOpen, onOpenChange);
  const multiple = Boolean(column.multiple);
  const emails = multiple
    ? normalizeActorValues(value)
    : typeof value === "string" && value
      ? [value.trim().toLowerCase()]
      : [];
  const selected = emails.map((email) => resolveActorCandidate(email, actors));
  const selectedSet = new Set(emails);
  const [allTime, setAllTime] = useState(column.display === "all_time");
  const [freeform, setFreeform] = useState("");

  useEffect(() => {
    return deferStateUpdate(() => {
      const sourceAllTime = column.display === "all_time";
      setAllTime(sourceAllTime);
      if (sourceAllTime) void onRequestActors?.(true);
    });
  }, [column.display, onRequestActors]);

  const sortedActors = useMemo(() => {
    const me = actors.filter(actorIsMe);
    const recent = actors
      .filter((actor) => !actorIsMe(actor))
      .sort(
        (a, b) => (actorLastCommitAt(b) ?? 0) - (actorLastCommitAt(a) ?? 0),
      )
      .slice(0, 5);
    const recentSet = new Set(recent.map((actor) => actor.email));
    const all = actors
      .filter((actor) => !actorIsMe(actor) && !recentSet.has(actor.email))
      .sort((a, b) => actorDisplayName(a).localeCompare(actorDisplayName(b)));
    return { me, recent, all };
  }, [actors]);

  const setActor = (email: string) => {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return;
    if (!multiple) {
      void onChange(normalized);
      setOpen(false);
      return;
    }
    if (selectedSet.has(normalized)) {
      void onChange(emails.filter((item) => item.toLowerCase() !== normalized));
    } else {
      void onChange([...emails, normalized]);
    }
  };

  const addFreeform = () => {
    const email = freeform.trim().toLowerCase();
    if (!isValidEmail(email)) return;
    setActor(email);
    setFreeform("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={cn(
            "min-w-0 justify-start px-1.5",
            invalid && "ring-1 ring-warning",
          )}
        >
          {selected.length > 0 ? (
            multiple ? (
              <ActorStack actors={selected} />
            ) : (
              <ActorInline actor={selected[0]} />
            )
          ) : (
            <span className="text-muted-foreground">{m.property_empty()}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput
            value={freeform}
            onValueChange={setFreeform}
            onKeyDown={(event) => {
              if (event.key === "Enter" && isValidEmail(freeform.trim())) {
                event.preventDefault();
                addFreeform();
              }
            }}
            placeholder={m.property_actor_search()}
          />
          <CommandList>
            <CommandEmpty>{m.property_no_options()}</CommandEmpty>
            <ActorGroup
              heading="Me"
              actors={sortedActors.me}
              selectedEmails={selectedSet}
              multiple={multiple}
              onSelect={(actor) => setActor(actor.email)}
            />
            <ActorGroup
              heading="Recent"
              actors={sortedActors.recent}
              selectedEmails={selectedSet}
              multiple={multiple}
              onSelect={(actor) => setActor(actor.email)}
            />
            <ActorGroup
              heading="All"
              actors={sortedActors.all}
              selectedEmails={selectedSet}
              multiple={multiple}
              onSelect={(actor) => setActor(actor.email)}
            />
          </CommandList>
          {multiple && selected.length > 0 ? (
            <div className="flex flex-wrap gap-1 border-t p-2">
              {selected.map((actor) => (
                <Button
                  key={actor.email}
                  type="button"
                  variant="secondary"
                  size="xs"
                  className="min-w-0 max-w-full justify-start rounded-full px-2"
                  onClick={() =>
                    void onChange(
                      emails.filter((email) => email !== actor.email),
                    )
                  }
                >
                  <span className="truncate">{actorDisplayName(actor)}</span>
                  <X data-icon="inline-end" />
                </Button>
              ))}
            </div>
          ) : null}
          <div className="border-t p-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              disabled={!isValidEmail(freeform.trim())}
              onClick={addFreeform}
            >
              {m.property_actor_enter_to_assign()}
            </Button>
          </div>
          <div className="flex items-center justify-between border-t px-3 py-2">
            <span className="text-xs text-muted-foreground">
              {m.property_actor_all_time()}
            </span>
            <Switch
              checked={allTime}
              onCheckedChange={(checked) => {
                setAllTime(checked);
                void onRequestActors?.(checked);
              }}
            />
          </div>
          <div className="border-t p-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={() => void onChange(null)}
            >
              {m.property_action_clear()}
            </Button>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function UrlControl({
  value,
  invalid,
  disabled,
  autoOpen,
  onChange,
  onOpenChange,
}: Pick<
  PropertyControlProps,
  "value" | "invalid" | "disabled" | "autoOpen" | "onChange" | "onOpenChange"
>) {
  const [open, setOpen] = useAutoOpen(autoOpen, onOpenChange);
  const normalized = normalizeUrlValue(value);
  const [draft, setDraft] = useState(normalized.href);
  const [text, setText] = useState(normalized.title);
  useEffect(() => {
    return deferStateUpdate(() => {
      const next = normalizeUrlValue(value);
      setDraft(next.href);
      setText(next.title);
    });
  }, [value]);
  const warning = invalid || (draft ? !isValidUrl(draft) : false);
  const commit = () => {
    const href = draft.trim();
    const title = text.trim();
    void onChange(
      href ? { href, title: title || fallbackUrlTitle(href) } : null,
    );
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div className="group/control relative">
          <Input
            value={draft}
            disabled={disabled}
            aria-invalid={warning || undefined}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            className="pr-16"
          />
          <div className="absolute top-1/2 right-1 flex -translate-y-1/2 opacity-0 group-focus-within/control:opacity-100 group-hover/control:opacity-100">
            <IconAction
              label={m.property_action_open()}
              onClick={() => openExternal(draft)}
              disabled={!isValidUrl(draft)}
            >
              <ExternalLink />
            </IconAction>
            <IconAction
              label={m.property_action_copy()}
              onClick={() => copyValue(draft)}
              disabled={!draft}
            >
              <Copy />
            </IconAction>
          </div>
        </div>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-80">
        <div className="grid grid-cols-[auto_1fr] items-center gap-2">
          <Link className="text-muted-foreground" />
          <Input
            value={draft}
            placeholder={m.doc_link_url_placeholder()}
            autoFocus={autoOpen}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
          />
          <Text className="text-muted-foreground" />
          <Input
            value={text}
            placeholder={m.doc_link_text_placeholder()}
            onChange={(event) => setText(event.target.value)}
            onBlur={commit}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function EmailControl({
  value,
  invalid,
  disabled,
  autoOpen,
  onChange,
}: Pick<
  PropertyControlProps,
  "value" | "invalid" | "disabled" | "autoOpen" | "onChange"
>) {
  const [draft, setDraft] = useState(valueToString(value));
  useEffect(
    () => deferStateUpdate(() => setDraft(valueToString(value))),
    [value],
  );
  const warning = invalid || !isValidEmail(draft);
  return (
    <div className="group/control relative">
      <Input
        autoFocus={autoOpen}
        type="email"
        value={draft}
        disabled={disabled}
        aria-invalid={warning || undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void onChange(draft || null)}
        className="pr-16"
      />
      <div className="absolute top-1/2 right-1 flex -translate-y-1/2 opacity-0 group-focus-within/control:opacity-100 group-hover/control:opacity-100">
        <IconAction
          label={m.property_action_email()}
          onClick={() => openExternal(`mailto:${draft}`)}
          disabled={!isValidEmail(draft)}
        >
          <Mail />
        </IconAction>
        <IconAction
          label={m.property_action_copy()}
          onClick={() => copyValue(draft)}
          disabled={!draft}
        >
          <Copy />
        </IconAction>
      </div>
    </div>
  );
}

function PhoneControl({
  value,
  invalid,
  disabled,
  autoOpen,
  onChange,
}: Pick<
  PropertyControlProps,
  "value" | "invalid" | "disabled" | "autoOpen" | "onChange"
>) {
  const [draft, setDraft] = useState(valueToString(value));
  useEffect(
    () => deferStateUpdate(() => setDraft(valueToString(value))),
    [value],
  );
  const warning = invalid || !isValidPhone(draft);
  return (
    <div className="group/control relative">
      <Input
        autoFocus={autoOpen}
        type="tel"
        value={draft}
        disabled={disabled}
        aria-invalid={warning || undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void onChange(draft || null)}
        className="pr-16"
      />
      <div className="absolute top-1/2 right-1 flex -translate-y-1/2 opacity-0 group-focus-within/control:opacity-100 group-hover/control:opacity-100">
        <IconAction
          label={m.property_action_call()}
          onClick={() => openExternal(`tel:${draft}`)}
          disabled={!isValidPhone(draft)}
        >
          <PhoneCall />
        </IconAction>
        <IconAction
          label={m.property_action_copy()}
          onClick={() => copyValue(draft)}
          disabled={!draft}
        >
          <Copy />
        </IconAction>
      </div>
    </div>
  );
}

function ActorGroup({
  heading,
  actors,
  selectedEmails,
  multiple,
  onSelect,
}: {
  heading: string;
  actors: ActorCandidate[];
  selectedEmails: Set<string>;
  multiple: boolean;
  onSelect: (actor: ActorCandidate) => void;
}) {
  if (actors.length === 0) return null;
  return (
    <CommandGroup heading={heading}>
      {actors.map((actor) => (
        <CommandItem
          key={actor.email}
          data-checked={selectedEmails.has(actor.email.toLowerCase())}
          value={`${actor.name} ${actor.email}`}
          onSelect={() => onSelect(actor)}
        >
          {multiple ? (
            <Checkbox
              checked={selectedEmails.has(actor.email.toLowerCase())}
              className="pointer-events-none"
            />
          ) : null}
          <ActorAvatar actor={actor} />
          <span className="min-w-0 flex-1 truncate">
            {actorDisplayName(actor)}
          </span>
          {actorCommitCount(actor) === 0 ? (
            <span className="text-xs text-muted-foreground">new</span>
          ) : null}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

function ActorStack({ actors }: { actors: ActorCandidate[] }) {
  return (
    <span className="inline-flex min-w-0 items-center">
      {actors.slice(0, 3).map((actor, index) => (
        <span key={actor.email} className={cn(index > 0 && "-ml-1.5")}>
          <ActorAvatar actor={actor} />
        </span>
      ))}
      {actors.length > 3 ? (
        <span className="ml-1 text-xs text-muted-foreground">
          +{actors.length - 3}
        </span>
      ) : null}
    </span>
  );
}

function ActorInline({ actor }: { actor: ActorCandidate }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ActorAvatar actor={actor} />
      <span className="min-w-0 truncate">{actorDisplayName(actor)}</span>
    </span>
  );
}

function ActorAvatar({ actor }: { actor: ActorCandidate }) {
  const color = ["blue", "green", "purple", "orange", "pink"][
    hashIndex(actor.email, 5)
  ];
  return (
    <Avatar size="sm" className="shrink-0">
      <AvatarImage src={gravatarUrl(actor.email)} alt="" />
      <AvatarFallback
        className={cn(
          "text-[10px] font-medium",
          color === "blue" &&
            "bg-(--property-blue-soft) text-(--property-blue)",
          color === "green" &&
            "bg-(--property-green-soft) text-(--property-green)",
          color === "purple" &&
            "bg-(--property-purple-soft) text-(--property-purple)",
          color === "orange" &&
            "bg-(--property-orange-soft) text-(--property-orange)",
          color === "pink" &&
            "bg-(--property-pink-soft) text-(--property-pink)",
        )}
      >
        {initialsForActor(actor)}
      </AvatarFallback>
    </Avatar>
  );
}

function OptionDot({ option }: { option: PropertyOption }) {
  return (
    <span
      className="size-2 shrink-0 rounded-full bg-(--property-color)"
      style={colorStyle(optionColor(option))}
    />
  );
}

function useAutoOpen(
  autoOpen: boolean | undefined,
  onOpenChange: ((open: boolean) => void) | undefined,
) {
  const [open, setOpen] = useState(Boolean(autoOpen));

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [onOpenChange],
  );

  return [open, handleOpenChange] as const;
}

function IconAction({
  label,
  children,
  className,
  disabled,
  onClick,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={className}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.preventDefault();
              onClick();
            }}
          >
            {children}
            <span className="sr-only">{label}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function commitNumber(
  value: string,
  onChange: PropertyControlProps["onChange"],
) {
  if (value.trim() === "") {
    void onChange(null);
    return;
  }
  const next = Number(value);
  if (Number.isFinite(next)) {
    void onChange(next);
  }
}

function datePart(value: string): string {
  return value.split("T")[0] ?? "";
}

function timePart(value: string): string {
  return value.includes("T") ? (value.split("T")[1]?.slice(0, 5) ?? "") : "";
}

function combineDateTime(date: string, time: string, hasTime: boolean): string {
  return hasTime ? `${date}T${time || "09:00"}` : date;
}

function copyValue(value: string) {
  if (!value) return;
  void navigator.clipboard?.writeText(value);
}

function openExternal(value: string) {
  if (!value) return;
  window.open(value, "_blank", "noopener,noreferrer");
}
