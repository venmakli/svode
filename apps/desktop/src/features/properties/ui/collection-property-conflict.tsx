import type { ComponentProps, ReactNode } from "react";
import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import * as m from "@/paraglide/messages.js";

import type {
  CollectionPropertyConflictEntry,
  CollectionPropertyConflictSide,
  CollectionPropertyPanelConflict,
} from "../model/collection-property-conflict";

/**
 * The line above the properties in conflict mode: how many properties both
 * sides changed differently, or, with none, that the changes are merged and
 * «Принять» takes them.
 */
export function ConflictSummary<Item>({
  conflict,
}: {
  conflict: CollectionPropertyPanelConflict<Item>;
}) {
  const count = conflict.disputed.length;
  return (
    <div className="flex flex-col gap-1.5" data-collection-panel-conflict>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-1.5 text-sm">
        <TriangleAlert aria-hidden className="size-4 shrink-0 text-warning" />
        <span
          className="min-w-0 text-foreground"
          data-collection-panel-conflict-summary
        >
          {count > 0
            ? m.property_conflict_summary({ count: String(count) })
            : m.property_conflict_merged()}
        </span>
        {count === 0 ? (
          conflict.accepted ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              {m.property_conflict_accepted()}
              <ConflictTextAction
                disabled={conflict.readOnly}
                onClick={() => conflict.onAccept(false)}
              >
                {m.changes_conflict_change_choice()}
              </ConflictTextAction>
            </span>
          ) : (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={conflict.readOnly}
              onClick={() => conflict.onAccept(true)}
            >
              {m.property_conflict_accept()}
            </Button>
          )
        ) : null}
        {conflict.pending ? (
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {m.property_saving()}
          </span>
        ) : null}
      </div>
      {conflict.problem}
    </div>
  );
}

/** The label of a disputed property with the conflict mark before it. */
export function ConflictLabel({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex min-w-0 items-start"
      data-collection-panel-conflict-label
    >
      <span className="py-1.5 pl-1.5 leading-5">
        <TriangleAlert
          aria-label={m.changes_conflict_label()}
          className="mt-0.5 size-4 text-warning"
        />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * Below the value of a disputed property: the value of each side shown as
 * the property shows it, «Удалено» for a side that removed it, with
 * «Принять моё» and «Принять входящее»; once decided, what was taken and
 * «Изменить».
 */
export function ConflictDecision<Item>({
  conflict,
  entry,
  renderValue,
}: {
  conflict: CollectionPropertyPanelConflict<Item>;
  entry: CollectionPropertyConflictEntry<Item>;
  renderValue: (item: Item, text: string) => ReactNode;
}) {
  if (entry.decision) {
    return (
      <div
        className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground"
        data-collection-panel-conflict-decided={entry.decision}
      >
        {entry.decision === "ours"
          ? m.changes_conflict_accepted_ours()
          : entry.decision === "theirs"
            ? m.changes_conflict_accepted_theirs()
            : m.property_conflict_accepted_value()}
        <ConflictTextAction
          disabled={conflict.readOnly}
          onClick={() => conflict.onReopen(entry.key)}
        >
          {m.changes_conflict_change_choice()}
        </ConflictTextAction>
      </div>
    );
  }
  return (
    <div className="mt-1 flex flex-col gap-0.5">
      {(["ours", "theirs"] as const).map((side) => (
        <ConflictVariant
          key={side}
          side={side}
          entry={entry}
          disabled={conflict.readOnly}
          onChoose={() => conflict.onChoose(entry.key, side)}
          renderValue={renderValue}
        />
      ))}
    </div>
  );
}

function ConflictVariant<Item>({
  side,
  entry,
  disabled,
  onChoose,
  renderValue,
}: {
  side: CollectionPropertyConflictSide;
  entry: CollectionPropertyConflictEntry<Item>;
  disabled: boolean;
  onChoose: () => void;
  renderValue: (item: Item, text: string) => ReactNode;
}) {
  const variant = entry[side];
  return (
    <div
      className="flex min-w-0 items-center gap-2 rounded-md bg-muted/50 px-2 py-1"
      data-collection-panel-conflict-variant={side}
    >
      <div className="min-w-0 flex-1">
        {variant.deleted ? (
          <span className="text-muted-foreground italic">
            {m.property_conflict_deleted()}
          </span>
        ) : (
          renderValue(variant.item, variant.text)
        )}
      </div>
      <ConflictTextAction disabled={disabled} onClick={onChoose}>
        {side === "ours"
          ? m.changes_conflict_accept_ours()
          : m.changes_conflict_accept_theirs()}
      </ConflictTextAction>
    </div>
  );
}

function ConflictTextAction({
  className,
  ...props
}: ComponentProps<typeof Button>) {
  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      className={cn(
        "h-auto shrink-0 rounded-sm px-0.5 text-xs font-normal text-muted-foreground hover:text-foreground hover:no-underline",
        className,
      )}
      {...props}
    />
  );
}
