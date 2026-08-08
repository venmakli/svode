import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import * as m from "@/paraglide/messages.js";
import { cn } from "@/shared/lib/utils";

export function RoutineAutomaticConsent({
  enabled,
  error,
  loading,
  pending,
  compact = false,
  onChange,
}: {
  compact?: boolean;
  enabled: boolean;
  error: string | null;
  loading: boolean;
  pending: boolean;
  onChange(enabled: boolean): void;
}) {
  const disabled = loading || pending;
  return (
    <>
      <Field
        orientation="horizontal"
        data-disabled={disabled}
        data-invalid={Boolean(error)}
        className={cn("px-6 py-3", compact && "px-4 py-2")}
      >
        <Switch
          id="routine-automatic-consent"
          checked={enabled}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          onCheckedChange={(checked) => onChange(checked === true)}
        />
        <FieldContent>
          <FieldLabel htmlFor="routine-automatic-consent">
            {m.routines_automatic_consent_label()}
          </FieldLabel>
          {!compact || loading ? (
            <FieldDescription>
              {loading
                ? m.routines_automatic_consent_loading()
                : m.routines_automatic_consent_description()}
            </FieldDescription>
          ) : null}
          {error ? <FieldError>{error}</FieldError> : null}
        </FieldContent>
      </Field>
      <Separator />
    </>
  );
}
