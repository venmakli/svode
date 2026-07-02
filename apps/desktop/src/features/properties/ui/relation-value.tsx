import { useMemo, type ReactNode } from "react";
import { FileText, Link2Off, X } from "lucide-react";
import { useSpace } from "@/features/space";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import {
  normalizeRelationRoot,
  relationTargetSpacePath,
  relationTargetSpaceId,
  type RelationSpaceLookup,
  resolvedRelationPath,
} from "../lib/relation";
import type { Column, RelationContext, ResolvedRelationEntry } from "../model";
import { useResolvedRelations } from "../hooks/use-resolved-relations";
import { useRelationValues } from "../hooks/use-relation-values";
import * as m from "@/paraglide/messages.js";

export function RelationValue({
  column,
  value,
  context,
  onRemove,
  presentation = "default",
}: {
  column: Column;
  value: unknown;
  context?: RelationContext;
  onRemove?: (value: string) => void;
  presentation?: RelationValuePresentation;
}) {
  const values = useRelationValues(column, value);
  const relation = normalizeRelationRoot(column.relation);
  const relationScope = column.relationScope ?? null;
  const activeRootId = useSpace((state) => state.activeRootId);
  const activeRootPath = useSpace((state) => state.activeRootPath);
  const spaces = useSpace((state) => state.spaces);
  const lookup = useMemo<RelationSpaceLookup>(
    () => ({
      activeRootPath,
      spaces: spaces.map((space) => ({
        id: space.id,
        path: space.path,
      })),
    }),
    [activeRootPath, spaces],
  );
  const resolved = useResolvedRelations(
    context,
    relation,
    relationScope,
    values,
  );

  if (values.length === 0) {
    return <span className="text-muted-foreground">-</span>;
  }

  const openPath = context?.onOpenPath;
  const openRelationTarget = context?.onOpenRelationTarget;
  const targetSpaceId = relationTargetSpaceId(
    context?.spaceId,
    context?.projectSpaceId ?? activeRootId,
    relationScope,
  );
  const targetSpacePath = relationTargetSpacePath(
    context,
    relationScope,
    lookup,
  );
  const maxVisible = presentation === "table" ? 2 : values.length;
  const visibleValues = values.slice(0, maxVisible);
  const hiddenCount = values.length - visibleValues.length;

  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1",
        presentation === "table" ? "flex-nowrap overflow-hidden" : "flex-wrap",
      )}
    >
      {visibleValues.map((item) => {
        const hasResolution = resolved.has(item);
        const target = hasResolution ? resolved.get(item) : undefined;
        const status = relationStatus({
          relation,
          target,
          hasContext: Boolean(context?.spacePath),
          hasResolution,
        });
        return (
          <RelationChip
            key={item}
            value={item}
            target={target}
            status={status}
            onOpen={
              target && (openRelationTarget || openPath)
                ? () => {
                    const path = resolvedRelationPath(target);
                    if (!path) return;
                    if (openRelationTarget) {
                      openRelationTarget({
                        path,
                        title: target.title,
                        icon: target.icon,
                        spaceId: targetSpaceId,
                        spacePath: targetSpacePath,
                      });
                      return;
                    }
                    openPath?.(path, targetSpaceId);
                  }
                : undefined
            }
            onRemove={onRemove}
            presentation={presentation}
          />
        );
      })}
      {hiddenCount > 0 ? (
        <RelationOverflowCount
          count={hiddenCount}
          presentation={presentation}
        />
      ) : null}
    </span>
  );
}

type RelationValuePresentation = "default" | "table";

function RelationChip({
  value,
  target,
  status,
  onOpen,
  onRemove,
  presentation,
}: {
  value: string;
  target: ResolvedRelationEntry | null | undefined;
  status: RelationChipStatus;
  onOpen?: () => void;
  onRemove?: (value: string) => void;
  presentation: RelationValuePresentation;
}) {
  const broken = status === "orphan" || status === "out-of-scope";
  const pending = status === "loading" || status === "unresolved";
  const table = presentation === "table";
  const label = target?.title ?? compactRelationPath(value);
  const triggerClassName = cn(
    "inline-flex min-w-0 items-center gap-1 py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3",
    table && "max-w-full",
    onRemove ? "pl-1.5 pr-1" : "px-1.5",
  );
  const icon = broken ? (
    <Link2Off data-icon="inline-start" />
  ) : (
    <RelationEntryIcon icon={target?.icon} />
  );
  const removeButton = onRemove ? (
    <button
      type="button"
      className="inline-flex h-full shrink-0 items-center rounded-full px-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onRemove(value);
      }}
    >
      <X data-icon="inline-end" />
      <span className="sr-only">{m.property_relation_remove()}</span>
    </button>
  ) : null;
  const chipContainer = (children: ReactNode) => (
    <Badge
      variant={broken || pending ? "outline" : "secondary"}
      className={cn(
        "max-w-56 gap-0 rounded-full px-0",
        table && "max-w-[9rem] shrink",
        broken && "text-muted-foreground",
        pending && "text-muted-foreground",
      )}
    >
      {children}
      {removeButton}
    </Badge>
  );

  if (broken) {
    const tooltip =
      status === "orphan"
        ? m.property_relation_orphan_tooltip()
        : m.property_relation_out_of_scope_tooltip();
    const trigger = onRemove ? (
      <PopoverTrigger asChild>
        <button
          type="button"
          className={triggerClassName}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {icon}
          <span className="min-w-0 truncate line-through">{label}</span>
        </button>
      </PopoverTrigger>
    ) : (
      <span className={triggerClassName} tabIndex={0}>
        {icon}
        <span className="min-w-0 truncate line-through">{label}</span>
      </span>
    );
    return (
      <Popover modal={false}>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex min-w-0">
                {chipContainer(trigger)}
              </span>
            </TooltipTrigger>
            <TooltipContent>{tooltip}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {onRemove ? (
          <PopoverContent align="start" className="w-52 p-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-start text-destructive"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRemove(value);
              }}
            >
              <X data-icon="inline-start" />
              {m.property_relation_remove()}
            </Button>
          </PopoverContent>
        ) : null}
      </Popover>
    );
  }

  if (pending || !target || !onOpen) {
    return chipContainer(
      <span className={triggerClassName}>
        {icon}
        <span className="min-w-0 truncate">{label}</span>
      </span>,
    );
  }

  return chipContainer(
    <button
      type="button"
      className={triggerClassName}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen();
      }}
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
    </button>,
  );
}

function RelationOverflowCount({
  count,
  presentation,
}: {
  count: number;
  presentation: RelationValuePresentation;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-full px-1.5 text-muted-foreground",
        presentation === "table" && "shrink-0",
      )}
    >
      +{count}
    </Badge>
  );
}

export function RelationEntryIcon({ icon }: { icon?: string | null }) {
  if (icon) {
    return (
      <span data-icon="inline-start" className="shrink-0 text-xs">
        {icon}
      </span>
    );
  }
  return <FileText data-icon="inline-start" />;
}

type RelationChipStatus =
  | "loading"
  | "unresolved"
  | "ok"
  | "orphan"
  | "out-of-scope";

function relationStatus({
  relation,
  target,
  hasContext,
  hasResolution,
}: {
  relation: string;
  target: ResolvedRelationEntry | null | undefined;
  hasContext: boolean;
  hasResolution: boolean;
}): RelationChipStatus {
  if (!hasContext) return "unresolved";
  if (!hasResolution) return "loading";
  if (!target) return "orphan";
  const root = target.collectionRootPath ?? null;
  if (root && normalizeRelationRoot(root) !== relation) return "out-of-scope";
  return "ok";
}

function compactRelationPath(value: string) {
  const parts = value.split("/").filter(Boolean);
  if (parts.length <= 2) return value;
  return `${parts[0]}/.../${parts.at(-1)}`;
}
