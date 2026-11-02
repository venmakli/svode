import { useRef, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useSignalUserEdit } from "@/features/navigation";
import * as m from "@/paraglide/messages.js";

import { isEmptyValue } from "../lib/utils";
import type {
  CollectionPropertyActionState,
  CollectionPropertyDefinition,
  CollectionPropertyEdit,
  CollectionPropertyPopoverEditor,
} from "../model/collection-property";
import type { ActorCandidate, Column, RelationContext } from "../model/types";
import { validatePropertyValue } from "../model/validation";
import { CollectionPropertyValue } from "./collection-property-value";
import { PropertyControl } from "./property-control";
import { propertyValidationMessage } from "./validation-message";

const EDITOR_ATTRIBUTE = "data-collection-property-editor";

/**
 * Whether Escape in `target` belongs to an open edit of the property panel,
 * which it cancels, rather than to the surface around the panel.
 */
export function keepsCollectionPropertyEditorOnEscape(
  target: EventTarget | null,
): boolean {
  const element = target as Element | null;
  if (!element || typeof element.closest !== "function") return false;
  return (
    (element.tagName === "INPUT" || element.tagName === "TEXTAREA") &&
    element.closest(`[${EDITOR_ATTRIBUTE}]`) !== null
  );
}

export function readCollectionPropertyEditState<Item>(
  edit: CollectionPropertyEdit<Item>,
  item: Item,
): CollectionPropertyActionState {
  try {
    return edit.getState(item);
  } catch (error) {
    return { message: errorMessage(error), status: "error" };
  }
}

type EditorNotice = { kind: "error" | "invalid"; text: string } | null;

/**
 * An editable property of the panel with the control of its cell. Each value
 * is saved at once through the owner's `update`: the property waits while it
 * is written and its neighbours stay available; a refused write or a version
 * conflict shows the saved value and the reason at the property, and an
 * invalid value is not written. An update of the item from disk leaves an
 * open editor as it is.
 */
export function CollectionPropertyEditor<Item>({
  column,
  disabled: disabledByPanel = false,
  edit,
  invalid = false,
  item,
  property,
  relationContext,
  onRequestActors,
}: {
  /** The column of a standard value; none for a composite popover value. */
  column: Column | null;
  /** The saved value cannot be edited, as the panel shows next to it. */
  disabled?: boolean;
  edit: CollectionPropertyEdit<Item>;
  /** The saved value is invalid, as the panel shows next to it. */
  invalid?: boolean;
  item: Item;
  property: CollectionPropertyDefinition<Item>;
  relationContext?: RelationContext;
  onRequestActors?: (allTime: boolean) => Promise<ActorCandidate[]>;
}) {
  // A new revision draws the control again, dropping its draft.
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [notice, setNotice] = useState<EditorNotice>(null);
  // A saved edit of the object the main area shows keeps it in Now.
  const signalUserEdit = useSignalUserEdit();

  const saved = edit.popover?.getDraft
    ? edit.popover.getDraft(item)
    : property.getValue(item);
  const ownerState = readCollectionPropertyEditState(edit, item);
  const busy = pending || ownerState.status === "pending";
  const disabled = busy || disabledByPanel || ownerState.status === "disabled";

  const write = async (
    next: unknown,
    invalidNotice: (reason: string) => string = (reason) => reason,
  ) => {
    if (pendingRef.current || sameValue(next, saved)) return;
    // A composite draft is checked by its owner, not as a standard value.
    const problem =
      (column && !edit.popover ? standardProblem(column, next) : null) ??
      edit.validate?.(next, item) ??
      null;
    if (problem) {
      setNotice({ kind: "invalid", text: invalidNotice(problem) });
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setNotice(null);
    try {
      await edit.update(item, next);
      signalUserEdit();
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
      setRevision((current) => current + 1);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const ownerMessage =
    ownerState.status === "error"
      ? { kind: "error" as const, text: ownerState.message }
      : ownerState.status === "disabled" && edit.showDisabledReason !== false
        ? { kind: "reason" as const, text: ownerState.reason }
        : null;
  const message = notice ?? ownerMessage;
  const status = notice
    ? notice.kind
    : busy
      ? "pending"
      : ownerState.status === "error"
        ? "error"
        : ownerState.status === "disabled"
          ? "disabled"
          : "idle";

  let control: ReactNode;
  if (edit.popover) {
    control = (
      <CollectionPropertyPopover
        disabled={disabled}
        edit={edit}
        item={item}
        popover={edit.popover}
        property={property}
        onOpen={() => setNotice(null)}
        onSave={(draft) =>
          void write(draft, (reason) => m.property_change_not_saved({ reason }))
        }
        onDiscardInvalid={(reason) =>
          setNotice({
            kind: "invalid",
            text: m.property_change_not_saved({ reason }),
          })
        }
      />
    );
  } else if (column) {
    control = (
      <PropertyControl
        key={revision}
        actors={property.actorCandidates}
        column={column}
        value={saved}
        invalid={invalid || notice?.kind === "invalid"}
        disabled={disabled}
        relationContext={relationContext}
        onRequestActors={onRequestActors}
        placeholder={m.property_empty()}
        accessibilityLabel={
          property.getAccessibilityLabel?.(item) ?? property.label
        }
        onChange={(next) => write(next)}
      />
    );
  }

  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      {...{ [EDITOR_ATTRIBUTE]: property.key }}
      data-collection-panel-property-state={status}
      aria-busy={busy || undefined}
      onKeyDown={(event) => {
        // Escape put the saved value back into the field.
        if (event.key === "Escape" && notice?.kind === "invalid") {
          setNotice(null);
        }
      }}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="min-w-0 flex-1">{control}</div>
        {busy ? (
          <LoaderCircle
            className="size-3.5 shrink-0 animate-spin text-muted-foreground"
            data-collection-panel-property-pending
            aria-label={m.property_saving()}
          />
        ) : null}
      </div>
      {message ? (
        <span
          role={message.kind === "reason" ? undefined : "alert"}
          className={
            message.kind === "reason"
              ? "text-xs text-muted-foreground"
              : "text-xs text-destructive"
          }
          data-collection-panel-property-message={message.kind}
        >
          {message.text}
        </span>
      ) : null}
    </div>
  );
}

/**
 * A composite value: the value in the row opens its editor in a popover,
 * which checks the draft inside. Closing the popover saves the draft whole;
 * an invalid draft is dropped with "Change not saved"; Escape drops it
 * silently.
 */
function CollectionPropertyPopover<Item>({
  disabled,
  edit,
  item,
  popover,
  property,
  onDiscardInvalid,
  onOpen,
  onSave,
}: {
  disabled: boolean;
  edit: CollectionPropertyEdit<Item>;
  item: Item;
  popover: CollectionPropertyPopoverEditor<Item>;
  property: CollectionPropertyDefinition<Item>;
  onDiscardInvalid(reason: string): void;
  onOpen(): void;
  onSave(draft: unknown): void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<unknown>(null);
  const escapedRef = useRef(false);
  const saved = popover.getDraft
    ? popover.getDraft(item)
    : property.getValue(item);
  const problem = open ? (edit.validate?.(draft, item) ?? null) : null;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          escapedRef.current = false;
          setDraft(saved);
          setOpen(true);
          onOpen();
          return;
        }
        setOpen(false);
        if (escapedRef.current || sameValue(draft, saved)) return;
        if (problem) onDiscardInvalid(problem);
        else onSave(draft);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled}
          className="h-auto min-h-8 w-full min-w-0 justify-start px-1.5 py-1 text-left font-normal whitespace-normal"
        >
          {isEmptyValue(property.getValue(item)) ? (
            <span className="text-muted-foreground">{m.property_empty()}</span>
          ) : (
            <CollectionPropertyValue
              context="detail"
              property={property as CollectionPropertyDefinition<unknown>}
              item={item}
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80"
        data-collection-property-popover={property.key}
        onEscapeKeyDown={() => {
          escapedRef.current = true;
        }}
      >
        {popover.render({
          draft,
          item,
          problem,
          onDraftChange: setDraft,
        })}
        {problem ? (
          <span
            role="alert"
            className="text-xs text-destructive"
            data-collection-property-popover-problem
          >
            {problem}
          </span>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function standardProblem(column: Column, value: unknown): string | null {
  const validation = validatePropertyValue(column, value);
  if (!validation.invalid) return null;
  return (
    propertyValidationMessage(validation.code) ?? m.property_write_failed()
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  if (isEmptyValue(left) && isEmptyValue(right)) return true;
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : m.property_write_failed();
}
