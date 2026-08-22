import { Check } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/shared/lib/utils";
import * as m from "@/paraglide/messages.js";
import { effectiveBooleanDisplay } from "../model/boolean";

export function BooleanPropertyControl({
  display,
  value,
  invalid,
  disabled,
  accessibilityLabel,
  density = "default",
  onChange,
}: {
  display?: string | null;
  value: boolean;
  invalid?: boolean;
  disabled?: boolean;
  accessibilityLabel: string;
  density?: "default" | "compact";
  onChange: (value: boolean) => void;
}) {
  if (effectiveBooleanDisplay(display) === "switch") {
    return (
      <Switch
        checked={value}
        disabled={disabled}
        size={density === "compact" ? "sm" : "default"}
        aria-label={accessibilityLabel}
        aria-invalid={invalid || undefined}
        onCheckedChange={onChange}
      />
    );
  }

  return (
    <Checkbox
      checked={value}
      disabled={disabled}
      aria-label={accessibilityLabel}
      aria-invalid={invalid || undefined}
      onCheckedChange={(checked) => onChange(checked === true)}
    />
  );
}

export function BooleanPropertyValue({
  display,
  value,
}: {
  display?: string | null;
  value: boolean;
}) {
  const effectiveDisplay = effectiveBooleanDisplay(display);
  const label =
    effectiveDisplay === "switch"
      ? value
        ? m.property_boolean_on()
        : m.property_boolean_off()
      : value
        ? m.property_boolean_yes()
        : m.property_boolean_no();

  if (effectiveDisplay === "switch") {
    return (
      <span
        data-property-boolean-value={value ? "true" : "false"}
        data-property-boolean-display="switch"
        role="img"
        aria-label={label}
        className={cn(
          "inline-flex h-3.5 w-6 shrink-0 items-center rounded-full",
          value ? "bg-primary" : "bg-input dark:bg-input/80",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "size-3 rounded-full bg-background transition-transform dark:bg-foreground",
            value && "translate-x-2.5 dark:bg-primary-foreground",
          )}
        />
      </span>
    );
  }

  return (
    <span
      data-property-boolean-value={value ? "true" : "false"}
      data-property-boolean-display="checkbox"
      role="img"
      aria-label={label}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
        value
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input bg-background",
      )}
    >
      {value ? <Check className="size-3.5" aria-hidden /> : null}
    </span>
  );
}
