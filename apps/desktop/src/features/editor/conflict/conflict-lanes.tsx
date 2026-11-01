import { Fragment, type ComponentProps, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import * as m from "@/paraglide/messages.js";
import { cn } from "@/shared/lib/utils";

import "./conflict-lanes.css";

export type ConflictLaneSide = "ours" | "theirs";

/** An action of the action line: its text, what it does and whether it is pressed. */
export interface ConflictAction {
  key: string;
  label: string;
  onSelect: () => void;
  pressed?: boolean;
  /** The side the action takes, for its tone on hover. */
  side?: ConflictLaneSide;
}

/**
 * A conflict place in the text of a Page (DF-293 R5): no frame or title, the
 * action line «Конфликт · …» above the place, then a note and the lanes of
 * the sides in the conflict colours of «Изменения».
 */
export function ConflictLanes({
  heading,
  actions,
  disabled,
  note,
  children,
}: {
  /** What follows the mark in the action line, as the ambiguous block's title. */
  heading?: ReactNode;
  actions: readonly ConflictAction[];
  disabled: boolean;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div data-conflict-lanes className="my-2">
      <div
        role="group"
        aria-label={m.changes_conflict_label()}
        className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-xs leading-tight text-muted-foreground"
        data-conflict-actions
      >
        <span className="mr-1 font-semibold text-warning">
          {m.changes_conflict_label()}
        </span>
        {heading ? (
          <>
            <span className="font-medium text-foreground">{heading}</span>
            <Separator />
          </>
        ) : null}
        {actions.map((action, at) => (
          <Fragment key={action.key}>
            {at > 0 ? <Separator /> : null}
            <TextAction
              disabled={disabled}
              aria-pressed={action.pressed}
              data-conflict-action={action.key}
              className={cn(
                action.pressed && "font-medium text-foreground",
                action.side === "ours" &&
                  "hover:text-(--conflict-ours-label-fg)",
                action.side === "theirs" &&
                  "hover:text-(--conflict-theirs-label-fg)",
              )}
              onClick={action.onSelect}
            >
              {action.label}
            </TextAction>
          </Fragment>
        ))}
      </div>
      {note ? (
        <p className="mt-0.5 text-xs text-muted-foreground" data-conflict-note>
          {note}
        </p>
      ) : null}
      <div className="mt-1 flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

/**
 * A lane of a conflict place: the background of its side with a darker label
 * column, as the line numbers of «Изменения»; without a side, a neutral lane.
 */
export function ConflictLane({
  side,
  dimmed,
  children,
}: {
  side: ConflictLaneSide | null;
  /** Another side is chosen. */
  dimmed?: boolean;
  children: ReactNode;
}) {
  if (side === null) {
    return (
      <div
        className="rounded-sm bg-muted/60 px-3 py-1"
        data-conflict-lane="neutral"
      >
        {children}
      </div>
    );
  }
  const label =
    side === "ours" ? m.changes_conflict_ours() : m.changes_conflict_theirs();
  return (
    <div
      role="group"
      aria-label={label}
      data-conflict-lane={side}
      className={cn(
        "grid grid-cols-[5rem_minmax(0,1fr)] overflow-hidden rounded-sm",
        side === "ours" ? "bg-(--conflict-ours)" : "bg-(--conflict-theirs)",
        dimmed && "opacity-60",
      )}
    >
      <div
        aria-hidden
        className={cn(
          "px-2 pt-2 font-mono text-xs leading-none",
          side === "ours"
            ? "bg-(--conflict-ours-label) text-(--conflict-ours-label-fg)"
            : "bg-(--conflict-theirs-label) text-(--conflict-theirs-label-fg)",
        )}
      >
        {label}
      </div>
      <div className="min-w-0 px-3 py-1">{children}</div>
    </div>
  );
}

/** Lines of a conflict side as the file holds them. */
export function ConflictLines({ children }: { children: ReactNode }) {
  return (
    <pre className="font-mono text-sm whitespace-pre-wrap break-words">
      {children}
    </pre>
  );
}

function TextAction({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      variant="link"
      size="xs"
      className={cn(
        "h-auto rounded-sm px-0.5 text-xs font-normal text-muted-foreground hover:text-foreground hover:no-underline",
        className,
      )}
      {...props}
    />
  );
}

function Separator() {
  return (
    <span aria-hidden className="select-none opacity-60">
      |
    </span>
  );
}
