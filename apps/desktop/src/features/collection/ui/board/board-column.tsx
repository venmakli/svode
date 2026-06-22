import { useEffect, useRef, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PropertyBadge } from "@/features/properties/display";
import { cn } from "@/shared/lib/utils";
import { SortableBoardCard } from "./board-card";
import type { BoardCardModel, BoardCardProps, BoardColumnGroup } from "./types";
import * as m from "@/paraglide/messages.js";

export function BoardColumn({
  group,
  cards,
  count,
  activeEntryPath,
  overGroupKey,
  draftOpen,
  draftAsFolder,
  cardProps,
  onPointerEnter,
  onOpenDraft,
  onCancelDraft,
  onCreateDraft,
}: {
  group: BoardColumnGroup;
  cards: BoardCardModel[];
  count: number;
  activeEntryPath: string | null;
  overGroupKey: string | null;
  draftOpen: boolean;
  draftAsFolder: boolean;
  cardProps: Omit<BoardCardProps, "card" | "active">;
  onPointerEnter: () => void;
  onOpenDraft: (asFolder: boolean) => void;
  onCancelDraft: () => void;
  onCreateDraft: (title: string, asFolder: boolean) => void;
}) {
  const [collapsed, setCollapsed] = useState(Boolean(group.collapsedByDefault));
  const { isOver, setNodeRef } = useDroppable({
    id: `column:${group.key}`,
    data: { type: "column", groupKey: group.key },
  });
  const highlighted = isOver || overGroupKey === group.key;
  const collapsible = Boolean(group.collapsedByDefault);

  return (
    <section
      ref={setNodeRef}
      className={cn(
        "flex w-[280px] shrink-0 flex-col rounded-xl bg-foreground/[0.025] p-2 transition-colors",
        highlighted && "bg-accent/70 ring-1 ring-primary/20",
      )}
      onPointerEnter={onPointerEnter}
    >
      <div className="mb-2 flex items-center justify-between gap-2 border-b border-border/70 px-1.5 pb-2 pt-1">
        <button
          type="button"
          className="flex min-w-0 items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            if (collapsible) setCollapsed((value) => !value);
          }}
        >
          {collapsible ? collapsed ? <ChevronRight /> : <ChevronDown /> : null}
          {group.option ? (
            <PropertyBadge
              option={group.option}
              className="max-w-44 rounded-full px-2 py-0.5"
            />
          ) : (
            <span className="truncate text-sm font-medium">{group.label}</span>
          )}
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {count}
          </span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-[22px] rounded-md text-muted-foreground"
          onClick={(event) => onOpenDraft(event.shiftKey)}
        >
          <Plus data-icon="inline-start" />
          <span className="sr-only">{m.board_new_card()}</span>
        </Button>
      </div>

      {collapsed ? (
        <button
          type="button"
          className="rounded-md px-2 py-3 text-left text-xs text-muted-foreground hover:bg-accent"
          onClick={() => setCollapsed(false)}
        >
          {m.board_collapsed_count({ count })}
        </button>
      ) : (
        <div className="pr-1">
          <div className="flex min-h-24 flex-col gap-1.5 px-0.5 pb-1 pt-0.5">
            <SortableContext
              items={cards.map((card) => card.entry.path)}
              strategy={verticalListSortingStrategy}
            >
              {cards.map((card) => (
                <SortableBoardCard
                  key={card.entry.path}
                  card={card}
                  active={activeEntryPath === card.entry.path}
                  {...cardProps}
                />
              ))}
            </SortableContext>
            {highlighted ? (
              <div className="h-14 rounded-lg border border-dashed border-primary/40 bg-primary/5" />
            ) : null}
            {draftOpen ? (
              <BoardDraftCard
                groupLabel={group.label}
                asFolder={draftAsFolder}
                onCancel={onCancelDraft}
                onCreate={onCreateDraft}
              />
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-0.5 min-h-8 w-full justify-center rounded-lg border border-dashed border-foreground/15 bg-transparent px-2 text-xs font-normal text-muted-foreground shadow-none hover:border-foreground/20 hover:bg-foreground/[0.04] hover:text-foreground"
                onClick={(event) => onOpenDraft(event.shiftKey)}
              >
                <Plus data-icon="inline-start" />
                {m.board_new_card()}
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function BoardDraftCard({
  groupLabel,
  asFolder,
  onCancel,
  onCreate,
}: {
  groupLabel: string;
  asFolder: boolean;
  onCancel: () => void;
  onCreate: (title: string, asFolder: boolean) => void;
}) {
  const [title, setTitle] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="rounded-lg bg-card px-2 py-1.5 ring-1 ring-foreground/10">
      <Input
        ref={inputRef}
        value={title}
        placeholder={
          asFolder
            ? m.board_new_folder_placeholder({ group: groupLabel })
            : m.board_new_card_placeholder({ group: groupLabel })
        }
        className="h-7 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => {
          if (!title.trim()) onCancel();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
          if (event.key === "Enter") {
            event.preventDefault();
            const nextTitle = title.trim();
            if (nextTitle) onCreate(nextTitle, asFolder);
            else onCancel();
          }
        }}
      />
    </div>
  );
}
