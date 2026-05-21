import type { CSSProperties, ReactNode } from "react";
import { Check, Copy, ExternalLink, Mail, PhoneCall } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PropertyBadge } from "./property-badge";
import type { Column, Person, RelationContext } from "../model/types";
import {
  actorPerson,
  colorStyle,
  formatDateValue,
  gravatarUrl,
  hashIndex,
  initialsForPerson,
  isEmptyValue,
  normalizeActorValues,
  optionByName,
  personDisplayName,
  uniqueIdDisplay,
  valueToString,
} from "../lib/utils";
import * as m from "@/paraglide/messages.js";
import { RelationValue } from "./relation-control";

export function PropertyValueActions({
  column,
  value,
}: {
  column: Column;
  value: unknown;
}) {
  if (!["text", "url", "email", "phone", "unique_id"].includes(column.type)) {
    return null;
  }
  if (isEmptyValue(value)) return null;
  const raw =
    column.type === "url"
      ? urlHref(value)
      : column.type === "unique_id"
        ? uniqueIdDisplay(column, value)
        : valueToString(value);
  return (
    <span className="flex text-muted-foreground opacity-0 group-focus-within/cell:opacity-100 group-hover/cell:opacity-100">
      {column.type === "url" ? (
        <IconAction
          label={m.property_action_open()}
          onClick={() => openExternal(raw)}
        >
          <ExternalLink />
        </IconAction>
      ) : null}
      {column.type === "email" ? (
        <IconAction
          label={m.property_action_email()}
          onClick={() => openExternal(`mailto:${raw}`)}
        >
          <Mail />
        </IconAction>
      ) : null}
      {column.type === "phone" ? (
        <IconAction
          label={m.property_action_call()}
          onClick={() => openExternal(`tel:${raw}`)}
        >
          <PhoneCall />
        </IconAction>
      ) : null}
      <IconAction
        label={m.property_action_copy()}
        onClick={() => copyValue(raw)}
      >
        <Copy />
      </IconAction>
    </span>
  );
}

export function PropertyValue({
  column,
  value,
  persons = [],
  relationContext,
}: {
  column: Column;
  value: unknown;
  persons?: Person[];
  relationContext?: RelationContext;
}) {
  if (isEmptyValue(value)) {
    return <span className="text-muted-foreground">-</span>;
  }
  if (column.type === "unique_id") {
    return (
      uniqueIdDisplay(column, value) || (
        <span className="text-muted-foreground">
          {m.property_state_no_key()}
        </span>
      )
    );
  }
  if (column.type === "actor" || column.type === "person") {
    return <ActorValue column={column} value={value} persons={persons} />;
  }
  if (column.type === "relation") {
    return (
      <RelationValue column={column} value={value} context={relationContext} />
    );
  }
  if (column.type === "select" || column.type === "status") {
    const option =
      optionByName(column, value) ??
      (typeof value === "string"
        ? { name: value, color: "neutral" as const }
        : null);
    return option ? (
      <PropertyBadge option={option} className="rounded-full px-2" />
    ) : (
      <span className="text-muted-foreground">-</span>
    );
  }
  if (column.type === "multi_select") {
    const values = Array.isArray(value)
      ? value.filter((item) => typeof item === "string")
      : [];
    if (values.length === 0) {
      return <span className="text-muted-foreground">-</span>;
    }
    return (
      <span className="flex min-w-0 gap-1">
        {values.slice(0, 2).map((item) => {
          const option = optionByName(column, item) ?? {
            name: item,
            color: "neutral" as const,
          };
          return (
            <PropertyBadge
              key={item}
              option={option}
              className="max-w-24 rounded-full px-2"
            />
          );
        })}
        {values.length > 2 ? (
          <span className="text-xs text-muted-foreground">
            +{values.length - 2}
          </span>
        ) : null}
      </span>
    );
  }
  if (column.type === "date") return formatDateValue(value, column.display);
  if (column.type === "checkbox") {
    return Boolean(value) ? (
      <Check data-icon="inline-start" />
    ) : (
      <span className="text-muted-foreground">-</span>
    );
  }
  if (column.type === "number" && typeof value === "number") {
    if (column.display === "bar" || column.display === "ring") {
      return <NumberPreview column={column} value={value} />;
    }
    if (column.display === "percent") return `${value}%`;
  }
  if (column.type === "url") return urlLabel(value);
  return valueToString(value);
}

export function PersonValue({
  value,
  persons = [],
}: {
  value: unknown;
  persons?: Person[];
}) {
  const email = typeof value === "string" ? value : "";
  if (!email) return <span className="text-muted-foreground">-</span>;
  const person = persons.find(
    (item) => item.email.toLowerCase() === email.toLowerCase(),
  ) ?? { email, name: email, commitCount: 0, isMe: false };

  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
      <PersonAvatar person={person} />
      <span className="min-w-0 truncate">{personDisplayName(person)}</span>
    </span>
  );
}

export function ActorValue({
  column,
  value,
  persons = [],
}: {
  column: Column;
  value: unknown;
  persons?: Person[];
}) {
  const emails = column.multiple
    ? normalizeActorValues(value)
    : typeof value === "string" && value
      ? [value]
      : [];
  if (emails.length === 0)
    return <span className="text-muted-foreground">-</span>;

  if (!column.multiple) {
    return <PersonValue value={emails[0]} persons={persons} />;
  }

  const resolved = emails.map((email) => actorPerson(email, persons));
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex min-w-0 items-center">
            {resolved.slice(0, 3).map((person, index) => (
              <span key={person.email} className={cn(index > 0 && "-ml-1.5")}>
                <PersonAvatar person={person} />
              </span>
            ))}
            {resolved.length > 3 ? (
              <span className="ml-1 text-xs text-muted-foreground">
                +{resolved.length - 3}
              </span>
            ) : null}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {resolved.map((person) => personDisplayName(person)).join(", ")}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
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

export function NumberPreview({
  column,
  value,
}: {
  column: Column;
  value: number;
}) {
  const min = column.min ?? 0;
  const max = column.max ?? 100;
  const ratio = max === min ? 0 : ((value - min) / (max - min)) * 100;
  const clamped = Math.max(0, Math.min(100, ratio));

  if (column.display === "ring") {
    return (
      <div
        className="grid size-7 shrink-0 place-items-center rounded-full bg-[conic-gradient(var(--property-color)_var(--progress),var(--muted)_0)] text-[10px] font-medium text-muted-foreground"
        style={
          {
            ...colorStyle(column.color ?? "blue"),
            "--progress": `${clamped}%`,
          } as CSSProperties
        }
      >
        <div className="grid size-5 place-items-center rounded-full bg-background">
          {Math.round(clamped)}
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex w-full min-w-0 items-center gap-2">
            <Progress
              value={clamped}
              className="h-2 min-w-0 flex-1 [&_[data-slot=progress-indicator]]:bg-[var(--property-color)]"
              style={colorStyle(column.color ?? "blue")}
            />
            <span className="tabular-nums text-muted-foreground">{value}</span>
          </span>
        </TooltipTrigger>
        {value < min || value > max ? (
          <TooltipContent>
            {m.property_number_exact_value({ value: String(value) })}
          </TooltipContent>
        ) : null}
      </Tooltip>
    </TooltipProvider>
  );
}

function IconAction({
  label,
  children,
  onClick,
}: {
  label: string;
  children: ReactNode;
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
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
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

function copyValue(value: string) {
  if (!value) return;
  void navigator.clipboard?.writeText(value);
}

function openExternal(value: string) {
  if (!value) return;
  window.open(value, "_blank", "noopener,noreferrer");
}

function urlHref(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const href = (value as { href?: unknown }).href;
    return typeof href === "string" ? href : "";
  }
  return "";
}

function urlLabel(value: unknown) {
  if (value && typeof value === "object") {
    const record = value as { href?: unknown; title?: unknown };
    if (typeof record.title === "string" && record.title.trim()) {
      return record.title;
    }
    if (typeof record.href === "string") return fallbackUrlTitle(record.href);
  }
  if (typeof value === "string") return fallbackUrlTitle(value);
  return "";
}

function fallbackUrlTitle(href: string) {
  try {
    const url = new URL(href);
    return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return href.replace(/^https?:\/\//, "");
  }
}
