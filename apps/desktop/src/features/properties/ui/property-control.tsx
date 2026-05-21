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
import { cn } from "@/lib/utils";
import {
  Check,
  Copy,
  ExternalLink,
  Link,
  Mail,
  PhoneCall,
  Text,
} from "lucide-react";
import type {
  Column,
  DateRangeValue,
  Person,
  PropertyOption,
  RelationContext,
} from "../model/types";
import { RelationControl } from "./relation-control";
import { PropertyBadge } from "./property-badge";
import {
  STATUS_GROUPS,
  colorStyle,
  formatDateValue,
  gravatarUrl,
  hashIndex,
  hasOption,
  initialsForPerson,
  isDateRangeValue,
  isEmptyValue,
  isValidEmail,
  isValidPhone,
  isValidUrl,
  normalizeDateInput,
  optionByName,
  optionColor,
  personCommitCount,
  personDisplayName,
  personIsMe,
  personLastCommitAt,
  todayIsoDate,
  valueToString,
} from "../lib/utils";
import { fallbackUrlTitle, normalizeUrlValue } from "../lib/url";
import * as m from "@/paraglide/messages.js";

interface PropertyControlProps {
  column: Column;
  value: unknown;
  invalid?: boolean;
  disabled?: boolean;
  autoOpen?: boolean;
  persons?: Person[];
  relationContext?: RelationContext;
  onRequestPersons?: (allTime: boolean) => Promise<Person[]>;
  onChange: (value: unknown) => void | Promise<void>;
  onOpenChange?: (open: boolean) => void;
}

export function PropertyControl({
  column,
  value,
  invalid,
  disabled,
  autoOpen,
  persons = [],
  relationContext,
  onRequestPersons,
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
    case "person":
      return (
        <PersonControl
          column={column}
          value={value}
          invalid={invalid}
          disabled={disabled}
          autoOpen={autoOpen}
          persons={persons}
          onRequestPersons={onRequestPersons}
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
  useEffect(() => setDraft(valueToString(value)), [value]);
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
  useEffect(() => setDraft(valueToString(value)), [value]);
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
                  className="min-w-20 flex-1 [&_[data-slot=progress-indicator]]:bg-[var(--property-color)]"
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
      className="grid size-7 shrink-0 place-items-center rounded-full bg-[conic-gradient(var(--property-color)_var(--progress),var(--muted)_0)] text-[10px] font-medium text-muted-foreground"
      style={
        {
          ...colorStyle(color ?? "blue"),
          "--progress": `${value}%`,
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

function PersonControl({
  column,
  value,
  invalid,
  disabled,
  autoOpen,
  persons = [],
  onRequestPersons,
  onChange,
  onOpenChange,
}: Pick<
  PropertyControlProps,
  | "value"
  | "invalid"
  | "disabled"
  | "persons"
  | "onRequestPersons"
  | "onChange"
  | "autoOpen"
  | "onOpenChange"
> & { column: Column }) {
  const [open, setOpen] = useAutoOpen(autoOpen, onOpenChange);
  const email = typeof value === "string" ? value : "";
  const selected =
    persons.find(
      (person) => person.email.toLowerCase() === email.toLowerCase(),
    ) ?? (email ? { email, name: email, commitCount: 0, isMe: false } : null);
  const [allTime, setAllTime] = useState(column.display === "all_time");
  const [freeform, setFreeform] = useState("");

  useEffect(() => {
    const sourceAllTime = column.display === "all_time";
    setAllTime(sourceAllTime);
    if (sourceAllTime) void onRequestPersons?.(true);
  }, [column.display, onRequestPersons]);

  const sortedPersons = useMemo(() => {
    const me = persons.filter(personIsMe);
    const recent = persons
      .filter((person) => !personIsMe(person))
      .sort(
        (a, b) => (personLastCommitAt(b) ?? 0) - (personLastCommitAt(a) ?? 0),
      )
      .slice(0, 5);
    const recentSet = new Set(recent.map((person) => person.email));
    const all = persons
      .filter((person) => !personIsMe(person) && !recentSet.has(person.email))
      .sort((a, b) => personDisplayName(a).localeCompare(personDisplayName(b)));
    return { me, recent, all };
  }, [persons]);

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
          {selected ? (
            <PersonInline person={selected} />
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
            placeholder={m.property_person_search()}
          />
          <CommandList>
            <CommandEmpty>{m.property_no_options()}</CommandEmpty>
            <PersonGroup
              heading="Me"
              persons={sortedPersons.me}
              selectedEmail={email}
              onSelect={(person) => void onChange(person.email)}
            />
            <PersonGroup
              heading="Recent"
              persons={sortedPersons.recent}
              selectedEmail={email}
              onSelect={(person) => void onChange(person.email)}
            />
            <PersonGroup
              heading="All"
              persons={sortedPersons.all}
              selectedEmail={email}
              onSelect={(person) => void onChange(person.email)}
            />
          </CommandList>
          <div className="flex items-center justify-between border-t px-3 py-2">
            <span className="text-xs text-muted-foreground">
              {m.property_person_all_time()}
            </span>
            <Switch
              checked={allTime}
              onCheckedChange={(checked) => {
                setAllTime(checked);
                void onRequestPersons?.(checked);
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
    const next = normalizeUrlValue(value);
    setDraft(next.href);
    setText(next.title);
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
  useEffect(() => setDraft(valueToString(value)), [value]);
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
  useEffect(() => setDraft(valueToString(value)), [value]);
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

function PersonGroup({
  heading,
  persons,
  selectedEmail,
  onSelect,
}: {
  heading: string;
  persons: Person[];
  selectedEmail: string;
  onSelect: (person: Person) => void;
}) {
  if (persons.length === 0) return null;
  return (
    <CommandGroup heading={heading}>
      {persons.map((person) => (
        <CommandItem
          key={person.email}
          data-checked={
            person.email.toLowerCase() === selectedEmail.toLowerCase()
          }
          value={`${person.name} ${person.email}`}
          onSelect={() => onSelect(person)}
        >
          <PersonAvatar person={person} />
          <span className="min-w-0 flex-1 truncate">
            {personDisplayName(person)}
          </span>
          {personCommitCount(person) === 0 ? (
            <span className="text-xs text-muted-foreground">new</span>
          ) : null}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

function PersonInline({ person }: { person: Person }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <PersonAvatar person={person} />
      <span className="min-w-0 truncate">{personDisplayName(person)}</span>
    </span>
  );
}

function PersonAvatar({ person }: { person: Person }) {
  const color = ["blue", "green", "purple", "orange", "pink"][
    hashIndex(person.email, 5)
  ];
  return (
    <Avatar size="sm" className="shrink-0">
      <AvatarImage src={gravatarUrl(person.email)} alt="" />
      <AvatarFallback
        className={cn(
          "text-[10px] font-medium",
          color === "blue" &&
            "bg-[var(--property-blue-soft)] text-[var(--property-blue)]",
          color === "green" &&
            "bg-[var(--property-green-soft)] text-[var(--property-green)]",
          color === "purple" &&
            "bg-[var(--property-purple-soft)] text-[var(--property-purple)]",
          color === "orange" &&
            "bg-[var(--property-orange-soft)] text-[var(--property-orange)]",
          color === "pink" &&
            "bg-[var(--property-pink-soft)] text-[var(--property-pink)]",
        )}
      >
        {initialsForPerson(person)}
      </AvatarFallback>
    </Avatar>
  );
}

function OptionDot({ option }: { option: PropertyOption }) {
  return (
    <span
      className="size-2 shrink-0 rounded-full bg-[var(--property-color)]"
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
