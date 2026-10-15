import type { ReactNode } from "react";
import { Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** One line of the details: a path, its link target and a note under it. */
export interface CollectionDetailInfoRow {
  key: string;
  path: string;
  /** The target of a link or alias, shown as "path → target". */
  target?: string | null;
  /** Secondary facts of the line, such as a status or the agents reading it. */
  detail?: ReactNode;
}

export interface CollectionDetailInfoGroup {
  key: string;
  label: string;
  rows: readonly CollectionDetailInfoRow[];
}

/**
 * ⓘ of a fixed Collection item next to the identity of the peek top bar:
 * secondary origin facts on request instead of a block in the content.
 * Empty groups are not shown; without any group there is no ⓘ.
 */
export function CollectionDetailInfo({
  groups,
  title,
}: {
  groups: readonly CollectionDetailInfoGroup[];
  title: string;
}) {
  const visibleGroups = groups.filter((group) => group.rows.length > 0);
  if (visibleGroups.length === 0) return null;

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={title}
              data-collection-detail-info-trigger
            >
              <Info />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{title}</TooltipContent>
      </Tooltip>
      {/* Wider than the document details so full paths wrap in place. */}
      <PopoverContent
        align="start"
        className="max-h-(--radix-popover-content-available-height) w-[28rem] max-w-[calc(100vw-2rem)] overflow-y-auto"
        data-collection-detail-info
      >
        <PopoverHeader>
          <PopoverTitle>{title}</PopoverTitle>
        </PopoverHeader>
        {visibleGroups.map((group) => (
          <section
            key={group.key}
            className="flex min-w-0 flex-col gap-1.5"
            data-collection-detail-info-group={group.key}
          >
            <h3 className="text-xs font-medium text-muted-foreground">
              {group.label}
            </h3>
            <ul className="flex min-w-0 flex-col gap-2">
              {group.rows.map((row) => (
                <li key={row.key} className="flex min-w-0 flex-col gap-0.5">
                  <code className="block min-w-0 whitespace-pre-wrap break-all font-mono text-xs leading-5 select-text">
                    {row.path}
                    {row.target ? (
                      <>
                        <span className="text-muted-foreground"> → </span>
                        {row.target}
                      </>
                    ) : null}
                  </code>
                  {row.detail ? (
                    <div className="min-w-0 text-xs text-muted-foreground">
                      {row.detail}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </PopoverContent>
    </Popover>
  );
}
