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
import { formatMediaBytes } from "@/features/media";
import * as m from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";

import type {
  DocumentPartCount,
  DocumentSourceDescriptor,
} from "../model/types";

/** ⓘ of a document: format, size, the viewer's part count and modification date. */
export function DocumentDetailsPopover({
  source,
  parts,
}: {
  source: DocumentSourceDescriptor;
  /** Absent until a viewer has loaded the document. */
  parts: DocumentPartCount | null;
}) {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={m.document_details()}
            >
              <Info />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{m.document_details()}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-64">
        <PopoverHeader>
          <PopoverTitle>{m.document_details()}</PopoverTitle>
        </PopoverHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">
            {m.document_details_format()}
          </dt>
          <dd className="truncate text-right">{source.format.toUpperCase()}</dd>
          <dt className="text-muted-foreground">{m.document_details_size()}</dt>
          <dd className="text-right">{formatMediaBytes(source.sizeBytes)}</dd>
          {parts ? (
            <>
              <dt className="text-muted-foreground">{partsLabel(parts)}</dt>
              <dd className="text-right">{parts.count}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">
            {m.document_details_modified()}
          </dt>
          <dd className="text-right">
            <time dateTime={source.modifiedAt}>
              {new Intl.DateTimeFormat(getLocale(), {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(source.modifiedAt))}
            </time>
          </dd>
        </dl>
      </PopoverContent>
    </Popover>
  );
}

function partsLabel(parts: DocumentPartCount) {
  switch (parts.kind) {
    case "pages":
      return m.document_details_pages();
    case "sheets":
      return m.document_details_sheets();
    case "slides":
      return m.document_details_slides();
  }
}
