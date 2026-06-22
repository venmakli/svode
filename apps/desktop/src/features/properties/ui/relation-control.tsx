import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { FileText, Link2Off, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
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
import type { Entry } from "@/features/entry";
import {
  normalizeRelationRoot,
  relationValueForPath,
  resolvedRelationPath,
} from "../api/relation-api";
import type { Column, RelationContext, ResolvedRelationEntry } from "../model";
import { useRelationTargets } from "../hooks/use-relation-targets";
import { useResolvedRelations } from "../hooks/use-resolved-relations";
import * as m from "@/paraglide/messages.js";

function deferStateUpdate(update: () => void) {
  let cancelled = false;
  queueMicrotask(() => {
    if (!cancelled) update();
  });
  return () => {
    cancelled = true;
  };
}

interface RelationControlProps {
  column: Column;
  value: unknown;
  invalid?: boolean;
  disabled?: boolean;
  autoOpen?: boolean;
  context?: RelationContext;
  onChange: (value: unknown) => void | Promise<void>;
  onOpenChange?: (open: boolean) => void;
}

export function RelationControl({
  column,
  value,
  invalid,
  disabled,
  autoOpen,
  context,
  onChange,
  onOpenChange,
}: RelationControlProps) {
  const [open, setOpen] = useState(Boolean(autoOpen));
  const [query, setQuery] = useState("");
  const relation = normalizeRelationRoot(column.relation);
  const values = useRelationValues(column, value);
  const limitOne = column.limit === "one";
  const { targets, loading } = useRelationTargets({
    open,
    spacePath: context?.spacePath,
    projectPath: context?.projectPath,
    relation,
    query,
  });

  useEffect(() => {
    if (!autoOpen) return;
    return deferStateUpdate(() => setOpen(true));
  }, [autoOpen]);

  useEffect(() => {
    onOpenChange?.(open);
  }, [onOpenChange, open]);

  const selected = useMemo(() => new Set(values), [values]);

  const commit = useCallback(
    async (nextValues: string[]) => {
      if (limitOne) {
        await onChange(nextValues[0] ?? null);
        setOpen(false);
        return;
      }
      await onChange(nextValues.length > 0 ? nextValues : null);
    },
    [limitOne, onChange],
  );

  const addTarget = useCallback(
    (entry: Entry) => {
      const nextValue = relationValueForPath(relation, entry.path);
      if (!nextValue || selected.has(nextValue)) return;
      const nextValues = limitOne ? [nextValue] : [...values, nextValue];
      void commit(nextValues);
    },
    [commit, limitOne, relation, selected, values],
  );

  const removeValue = useCallback(
    (target: string) => {
      void commit(values.filter((item) => item !== target));
    },
    [commit, values],
  );

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <RelationValue
        column={column}
        value={value}
        context={context}
        onRemove={disabled ? undefined : removeValue}
      />
      {(!limitOne || values.length === 0) && !disabled ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                "h-7 rounded-md px-2 text-xs text-muted-foreground",
                invalid && "ring-1 ring-warning",
              )}
            >
              {values.length === 0
                ? m.property_relation_add()
                : m.property_relation_add_another()}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-0">
            <Command shouldFilter={false}>
              <CommandInput
                value={query}
                onValueChange={setQuery}
                placeholder={m.property_relation_search_placeholder()}
              />
              <CommandList>
                <CommandEmpty>
                  {loading
                    ? m.property_relation_loading()
                    : m.property_relation_empty()}
                </CommandEmpty>
                <CommandGroup heading={m.property_relation_targets()}>
                  {targets.map((entry) => {
                    const targetValue = relationValueForPath(
                      relation,
                      entry.path,
                    );
                    return (
                      <CommandItem
                        key={entry.path}
                        value={`${entry.meta.title} ${entry.path}`}
                        disabled={selected.has(targetValue)}
                        onSelect={() => addTarget(entry)}
                      >
                        <EntryIcon icon={entry.meta.icon} />
                        <span className="min-w-0 flex-1 truncate">
                          {entry.meta.title}
                        </span>
                        <span className="max-w-28 truncate text-xs text-muted-foreground">
                          {targetValue}
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}

export function RelationValue({
  column,
  value,
  context,
  onRemove,
}: {
  column: Column;
  value: unknown;
  context?: RelationContext;
  onRemove?: (value: string) => void;
}) {
  const values = useRelationValues(column, value);
  const relation = normalizeRelationRoot(column.relation);
  const resolved = useResolvedRelations(context, relation, values);

  if (values.length === 0) {
    return <span className="text-muted-foreground">-</span>;
  }

  const openPath = context?.onOpenPath;

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {values.map((item) => {
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
              target && openPath
                ? () => openPath(resolvedRelationPath(target))
                : undefined
            }
            onRemove={onRemove}
          />
        );
      })}
    </span>
  );
}

function RelationChip({
  value,
  target,
  status,
  onOpen,
  onRemove,
}: {
  value: string;
  target: ResolvedRelationEntry | null | undefined;
  status: RelationChipStatus;
  onOpen?: () => void;
  onRemove?: (value: string) => void;
}) {
  const broken = status === "orphan" || status === "out-of-scope";
  const pending = status === "loading" || status === "unresolved";
  const label = target?.title ?? compactRelationPath(value);
  const triggerClassName = cn(
    "inline-flex min-w-0 items-center gap-1 py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3",
    onRemove ? "pl-1.5 pr-1" : "px-1.5",
  );
  const icon = broken ? (
    <Link2Off data-icon="inline-start" />
  ) : (
    <EntryIcon icon={target?.icon} />
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

function EntryIcon({ icon }: { icon?: string | null }) {
  if (icon) {
    return (
      <span data-icon="inline-start" className="shrink-0 text-xs">
        {icon}
      </span>
    );
  }
  return <FileText data-icon="inline-start" />;
}

function useRelationValues(column: Column, value: unknown) {
  return useMemo(() => normalizeRelationValues(column, value), [column, value]);
}

function normalizeRelationValues(column: Column, value: unknown) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];
  const values = Array.from(
    new Set(
      raw
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.replace(/\\/g, "/").replace(/^\/+/, ""))
        .filter(Boolean),
    ),
  );
  return column.limit === "one" ? values.slice(0, 1) : values;
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
  const root = target.collectionRootPath ?? target.collection_root_path ?? null;
  if (root && normalizeRelationRoot(root) !== relation) return "out-of-scope";
  return "ok";
}

function compactRelationPath(value: string) {
  const parts = value.split("/").filter(Boolean);
  if (parts.length <= 2) return value;
  return `${parts[0]}/.../${parts.at(-1)}`;
}
