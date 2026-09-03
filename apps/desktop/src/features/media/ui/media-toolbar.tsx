import type { ReactNode } from "react";
import { FileImage, FolderOpen, Info, Music, Video } from "lucide-react";

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
import * as m from "@/paraglide/messages.js";

import type { MediaSourceDescriptor } from "../model/types";

export function MediaToolbar({
  children,
  onOpenExternal,
  source,
  title,
  toolbarActions,
}: {
  children?: ReactNode;
  onOpenExternal(): void;
  source: MediaSourceDescriptor;
  title: string;
  toolbarActions?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-background px-2 py-2">
      <MediaFamilyIcon family={source.family} />
      <div
        className="min-w-16 flex-1 truncate text-sm font-medium"
        title={title}
      >
        {title}
      </div>
      {children}
      <MediaMetadataPopover source={source} />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={m.media_open_externally()}
            onClick={onOpenExternal}
          >
            <FolderOpen />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{m.media_open_externally()}</TooltipContent>
      </Tooltip>
      {toolbarActions}
    </div>
  );
}

export function MediaFamilyIcon({
  family,
}: {
  family: MediaSourceDescriptor["family"];
}) {
  const className = "size-4 shrink-0 text-muted-foreground";
  if (family === "audio") {
    return <Music className={className} aria-hidden />;
  }
  if (family === "video") {
    return <Video className={className} aria-hidden />;
  }
  return <FileImage className={className} aria-hidden />;
}

function MediaMetadataPopover({ source }: { source: MediaSourceDescriptor }) {
  const showDimensions = source.family !== "audio";
  const showDuration = source.family !== "image";
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={m.media_metadata()}
            >
              <Info />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{m.media_metadata()}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-64">
        <PopoverHeader>
          <PopoverTitle>{m.media_metadata()}</PopoverTitle>
        </PopoverHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{m.media_metadata_format()}</dt>
          <dd className="truncate text-right">
            {formatMediaName(source.format)}
          </dd>
          {showDimensions ? (
            <>
              <dt className="text-muted-foreground">
                {m.media_metadata_dimensions()}
              </dt>
              <dd className="text-right">
                {source.width && source.height
                  ? `${source.width} × ${source.height}`
                  : m.media_metadata_unavailable()}
              </dd>
            </>
          ) : null}
          {showDuration ? (
            <>
              <dt className="text-muted-foreground">
                {m.media_metadata_duration()}
              </dt>
              <dd className="text-right">
                {typeof source.durationSeconds === "number"
                  ? formatMediaDuration(source.durationSeconds)
                  : m.media_metadata_unavailable()}
              </dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">{m.media_metadata_size()}</dt>
          <dd className="text-right">{formatMediaBytes(source.sizeBytes)}</dd>
        </dl>
      </PopoverContent>
    </Popover>
  );
}

export function formatMediaBytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  const exponent = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length,
  );
  const scaled = value / 1024 ** exponent;
  const formatted =
    scaled < 10 && !Number.isInteger(scaled)
      ? scaled.toFixed(1).replace(/\.0$/u, "")
      : String(Math.round(scaled));
  return `${formatted} ${units[exponent - 1]}`;
}

export function formatMediaDuration(value: number) {
  if (!Number.isFinite(value) || value < 0)
    return m.media_metadata_unavailable();
  const totalSeconds = Math.floor(value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatMediaName(format: MediaSourceDescriptor["format"]) {
  return format === "three_gp" ? "3GP" : format.toUpperCase();
}
