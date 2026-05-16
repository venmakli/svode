import type { CSSProperties, ReactNode } from "react";
import { Check, Copy, ExternalLink, Mail, PhoneCall } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PropertyBadge } from "@/features/properties/property-badge";
import type { Column } from "@/features/properties/types";
import {
  colorStyle,
  formatDateValue,
  isEmptyValue,
  optionByName,
  valueToString,
} from "@/features/properties/utils";
import * as m from "@/paraglide/messages.js";

export function CellActions({
  column,
  value,
}: {
  entryPath: string;
  column: Column;
  value: unknown;
}) {
  if (!["text", "url", "email", "phone"].includes(column.type)) return null;
  if (isEmptyValue(value)) return null;
  const raw = column.type === "url" ? urlHref(value) : valueToString(value);
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
}: {
  column: Column;
  value: unknown;
}) {
  if (isEmptyValue(value)) {
    return <span className="text-muted-foreground">-</span>;
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
          <span className="flex items-center gap-2">
            <Progress
              value={clamped}
              className="h-2 w-20 [&_[data-slot=progress-indicator]]:bg-[var(--property-color)]"
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
