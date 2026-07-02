import { useCallback, useEffect, useMemo, useState } from "react";
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
import { cn } from "@/shared/lib/utils";
import { normalizeRelationRoot, relationValueForPath } from "../lib/relation";
import type { Column, RelationContext, RelationTarget } from "../model";
import { useRelationTargets } from "../hooks/use-relation-targets";
import { useRelationValues } from "../hooks/use-relation-values";
import { RelationEntryIcon, RelationValue } from "./relation-value";
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
  const relationScope = column.relationScope ?? null;
  const values = useRelationValues(column, value);
  const limitOne = column.limit === "one";
  const { targets, loading } = useRelationTargets({
    open,
    spacePath: context?.spacePath,
    projectPath: context?.projectPath,
    relation,
    relationScope,
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
    (target: RelationTarget) => {
      const nextValue = relationValueForPath(relation, target.path);
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
                        value={`${entry.title} ${entry.path}`}
                        disabled={selected.has(targetValue)}
                        onSelect={() => addTarget(entry)}
                      >
                        <RelationEntryIcon icon={entry.icon} />
                        <span className="min-w-0 flex-1 truncate">
                          {entry.title}
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
