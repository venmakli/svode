import { Clock, LoaderCircle, Play, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import * as m from "@/paraglide/messages.js";

import type { RoutineCreateInput, RoutineTriggerType } from "../model/types";

export function RoutineCreateDialog({
  collectionOwner,
  error,
  input,
  open,
  pending,
  onChange,
  onClose,
  onSubmit,
}: {
  collectionOwner: boolean;
  error: string | null;
  input: RoutineCreateInput;
  open: boolean;
  pending: boolean;
  onChange(input: RoutineCreateInput): void;
  onClose(): void;
  onSubmit(): void;
}) {
  const titleInvalid = !input.title.trim();
  const timezoneInvalid =
    input.triggerType === "schedule" && !input.timezone?.trim();

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.routines_create_title()}</DialogTitle>
          <DialogDescription>
            {m.routines_create_description()}
          </DialogDescription>
        </DialogHeader>
        <form
          id="routine-create-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!titleInvalid && !timezoneInvalid) onSubmit();
          }}
        >
          <FieldGroup>
            <Field data-invalid={titleInvalid}>
              <FieldLabel htmlFor="routine-create-title">
                {m.routines_title_label()}
              </FieldLabel>
              <Input
                id="routine-create-title"
                autoFocus
                aria-invalid={titleInvalid}
                value={input.title}
                onChange={(event) =>
                  onChange({ ...input, title: event.target.value })
                }
              />
              {titleInvalid ? (
                <FieldError>{m.routines_title_required()}</FieldError>
              ) : null}
            </Field>
            <Field>
              <FieldLabel htmlFor="routine-create-description">
                {m.routines_description_label()}
              </FieldLabel>
              <Textarea
                id="routine-create-description"
                maxLength={2000}
                value={input.description}
                onChange={(event) =>
                  onChange({ ...input, description: event.target.value })
                }
              />
              <FieldDescription>
                {m.routines_description_hint()}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel id="routine-create-trigger-label">
                {m.routines_trigger_label()}
              </FieldLabel>
              <ToggleGroup
                type="single"
                variant="outline"
                spacing={2}
                value={input.triggerType}
                aria-labelledby="routine-create-trigger-label"
                onValueChange={(value) => {
                  if (!value) return;
                  onChange({
                    ...input,
                    triggerType: value as RoutineTriggerType,
                  });
                }}
              >
                <ToggleGroupItem value="manual">
                  <Play />
                  {m.routines_trigger_manual()}
                </ToggleGroupItem>
                <ToggleGroupItem value="schedule">
                  <Clock />
                  {m.routines_trigger_schedule()}
                </ToggleGroupItem>
                {collectionOwner ? (
                  <ToggleGroupItem value="event">
                    <Zap />
                    {m.routines_trigger_event()}
                  </ToggleGroupItem>
                ) : null}
              </ToggleGroup>
              <FieldDescription>
                {m.routines_create_trigger_hint()}
              </FieldDescription>
            </Field>
            {input.triggerType === "schedule" ? (
              <Field data-invalid={timezoneInvalid}>
                <FieldLabel htmlFor="routine-create-timezone">
                  {m.routines_timezone_label()}
                </FieldLabel>
                <Input
                  id="routine-create-timezone"
                  aria-invalid={timezoneInvalid}
                  value={input.timezone ?? ""}
                  onChange={(event) =>
                    onChange({ ...input, timezone: event.target.value })
                  }
                />
                {timezoneInvalid ? (
                  <FieldError>{m.routines_timezone_required()}</FieldError>
                ) : (
                  <FieldDescription>
                    {m.routines_timezone_hint()}
                  </FieldDescription>
                )}
              </Field>
            ) : null}
          </FieldGroup>
        </form>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={onClose}
          >
            {m.routines_cancel()}
          </Button>
          <Button
            type="submit"
            form="routine-create-form"
            disabled={pending || titleInvalid || timezoneInvalid}
          >
            {pending ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : null}
            {pending ? m.routines_creating() : m.routines_create_confirm()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
