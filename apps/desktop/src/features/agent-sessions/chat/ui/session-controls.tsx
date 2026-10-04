import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/shared/lib/utils";
import { getLocale } from "@/paraglide/runtime.js";
import {
  contextUsage,
  currentOptionName,
  type ContextLevel,
  type SessionSetting,
  type SettingValue,
} from "../model/session-controls";
import type { AgentSessionUsageDto } from "../api/chat";
import type { SettingChangeRefusal } from "../hooks/use-session-settings";
import * as m from "@/paraglide/messages.js";

/**
 * The permission mode under the field (`04` composer): the agent's `mode`
 * setting with its names, switched more often than the model. The shown
 * value is the one the agent confirmed.
 */
export function ModeSelect({
  mode,
  canChange,
  changing,
  onChange,
}: {
  mode: SessionSetting;
  canChange: boolean;
  changing: boolean;
  onChange: (value: SettingValue) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          disabled={!canChange || changing}
          className="max-w-48 text-muted-foreground"
          aria-label={m.sessions_chat_mode_choose({
            mode: currentOptionName(mode),
          })}
        >
          <span className="truncate">{currentOptionName(mode)}</span>
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="min-w-56">
        <DropdownMenuRadioGroup
          value={mode.currentValue}
          onValueChange={(value) => {
            if (value !== mode.currentValue) {
              onChange({ setting: mode.id, value });
            }
          }}
        >
          {mode.options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{option.name}</span>
                {option.description && (
                  <span className="text-xs text-muted-foreground">
                    {option.description}
                  </span>
                )}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const LEVEL_COLOR: Record<ContextLevel, string> = {
  normal: "text-muted-foreground",
  warning: "text-warning",
  critical: "text-destructive",
};

/**
 * The context indicator (`04` composer): a ring filled by the agent's last
 * usage report, warning from 75% and critical from 90%; its popover tells
 * the numbers and the cost when the agent sent one. Without a report with
 * both `used` and `size` there is no indicator.
 */
export function ContextIndicator({
  usage,
}: {
  usage: AgentSessionUsageDto | null;
}) {
  const context = contextUsage(usage);
  if (!context) return null;
  const locale = getLocale();
  const number = new Intl.NumberFormat(locale);
  const percent = new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(context.fraction);
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className={LEVEL_COLOR[context.level]}
          aria-label={m.sessions_chat_context_label({ percent })}
        >
          <svg
            viewBox="0 0 16 16"
            className="size-4 -rotate-90"
            aria-hidden="true"
          >
            <circle
              cx="8"
              cy="8"
              r={radius}
              fill="none"
              strokeWidth="2"
              className="stroke-current opacity-25"
            />
            <circle
              cx="8"
              cy="8"
              r={radius}
              fill="none"
              strokeWidth="2"
              strokeLinecap="round"
              className="stroke-current"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - context.fraction)}
            />
          </svg>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="w-60 gap-1.5 p-3 text-sm"
      >
        <p className="font-medium">{m.sessions_chat_context_title()}</p>
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">
            {m.sessions_chat_context_used()}
          </dt>
          <dd className="text-end tabular-nums">
            {number.format(context.used)}
          </dd>
          <dt className="text-muted-foreground">
            {m.sessions_chat_context_size()}
          </dt>
          <dd className="text-end tabular-nums">
            {number.format(context.size)}
          </dd>
          <dt className="text-muted-foreground">
            {m.sessions_chat_context_percent()}
          </dt>
          <dd
            className={cn("text-end tabular-nums", LEVEL_COLOR[context.level])}
          >
            {percent}
          </dd>
          {context.cost && (
            <>
              <dt className="text-muted-foreground">
                {m.sessions_chat_context_cost()}
              </dt>
              <dd className="text-end tabular-nums">
                {formatCost(locale, context.cost)}
              </dd>
            </>
          )}
        </dl>
      </PopoverContent>
    </Popover>
  );
}

function formatCost(
  locale: string,
  cost: NonNullable<AgentSessionUsageDto["cost"]>,
): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: cost.currency,
      maximumFractionDigits: 4,
    }).format(cost.amount);
  } catch {
    // An agent's currency code Intl does not know.
    return `${cost.amount} ${cost.currency}`;
  }
}

/** A setting value the agent did not take; the earlier value stays. */
export function SettingRefusalLine({
  refusal,
  settings,
}: {
  refusal: SettingChangeRefusal;
  settings: SessionSetting[];
}) {
  const setting = settings.find((known) => known.id === refusal.setting);
  const value =
    setting?.options.find((option) => option.value === refusal.value)?.name ??
    refusal.value;
  const reason =
    refusal.reason.kind === "not_declared"
      ? m.sessions_chat_setting_not_declared()
      : refusal.reason.message;
  return (
    <p className="text-xs break-words text-destructive">
      {m.sessions_chat_setting_refused({
        setting: setting?.name ?? refusal.setting,
        value,
        reason,
      })}
    </p>
  );
}
