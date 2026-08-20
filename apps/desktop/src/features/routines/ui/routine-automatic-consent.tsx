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

import type { RoutineResolvedOwnerKind } from "../model/types";

export function RoutineAutomaticConsent({
  enabled,
  error,
  loading,
  ownerKind,
  pending,
  compact = false,
  onChange,
}: {
  compact?: boolean;
  enabled: boolean | null;
  error: string | null;
  loading: boolean;
  ownerKind: RoutineResolvedOwnerKind;
  pending: boolean;
  onChange(enabled: boolean): void;
}) {
  const disabled = enabled === null || loading || pending;
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
          checked={enabled === true}
          disabled={disabled}
          aria-busy={disabled}
          aria-invalid={Boolean(error)}
          onCheckedChange={(checked) => onChange(checked === true)}
        />
        <FieldContent>
          <FieldLabel htmlFor="routine-automatic-consent">
            {automaticAuthorityLabel(ownerKind)}
          </FieldLabel>
          {!compact || loading ? (
            <FieldDescription>
              {loading
                ? m.routines_automatic_authority_loading()
                : m.routines_automatic_authority_description()}
            </FieldDescription>
          ) : null}
          {error ? <FieldError>{error}</FieldError> : null}
        </FieldContent>
      </Field>
      <Separator />
    </>
  );
}

function automaticAuthorityLabel(ownerKind: RoutineResolvedOwnerKind) {
  switch (ownerKind) {
    case "project":
      return m.routines_automatic_authority_project_label();
    case "space":
      return m.routines_automatic_authority_space_label();
    case "collection":
      return m.routines_automatic_authority_collection_label();
  }
}
