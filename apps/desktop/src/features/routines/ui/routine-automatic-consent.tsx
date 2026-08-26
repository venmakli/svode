import { useId } from "react";
import { Power } from "lucide-react";

import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import * as m from "@/paraglide/messages.js";

import type { RoutineResolvedOwnerKind } from "../model/types";

export function RoutineAutomaticConsent({
  enabled,
  error,
  loading,
  ownerKind,
  pending,
  onChange,
}: {
  enabled: boolean | null;
  error: string | null;
  loading: boolean;
  ownerKind: RoutineResolvedOwnerKind;
  pending: boolean;
  onChange(enabled: boolean): void;
}) {
  const controlId = useId();
  const descriptionId = `${controlId}-description`;
  const label = automaticAuthorityLabel(ownerKind);
  const description = m.routines_automatic_authority_description();
  const unavailable = enabled === null && !loading;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Label
          htmlFor={controlId}
          data-disabled={loading || pending || unavailable}
          data-invalid={Boolean(error)}
          aria-disabled={loading || pending || unavailable}
          className="h-7 w-auto shrink-0 gap-1.5 rounded-md border bg-background px-2 data-[disabled=true]:opacity-50 data-[invalid=true]:border-destructive data-[invalid=true]:text-destructive"
          data-routine-automatic-authority={ownerKind}
        >
          <Power
            aria-hidden="true"
            className={
              enabled === true
                ? "size-3.5 text-foreground"
                : "size-3.5 text-muted-foreground"
            }
          />
          {loading ? (
            <Skeleton className="h-3.5 w-6 rounded-full" aria-hidden="true" />
          ) : (
            <Switch
              id={controlId}
              size="sm"
              checked={enabled === true}
              disabled={pending || unavailable}
              aria-busy={pending}
              aria-describedby={descriptionId}
              aria-invalid={Boolean(error)}
              aria-label={label}
              onCheckedChange={(checked) => {
                if (!unavailable) onChange(checked === true);
              }}
            />
          )}
          <span
            id={descriptionId}
            className="sr-only"
            role="status"
            aria-live="polite"
          >
            {loading
              ? m.routines_automatic_authority_loading()
              : `${description}${error ? ` ${error}` : ""}`}
            {pending ? ` ${m.routines_saving()}` : ""}
          </span>
        </Label>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 flex-col items-start">
        <span className="font-medium">{label}</span>
        <span>{description}</span>
        {error ? <span>{error}</span> : null}
      </TooltipContent>
    </Tooltip>
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
