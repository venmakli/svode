import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { CoverBanner } from "./cover-banner";
import { TitleZone } from "./title-zone";
import { cn } from "@/shared/lib/utils";
import type { EntryCover } from "../model/types";

interface EntryIdentityHeaderProps {
  title: string;
  icon: string | null;
  description: string;
  cover: EntryCover | null;
  projectPath: string | null;
  spacePath: string;
  documentPath: string | null;
  onTitleChange: (title: string) => void;
  onIconChange: (icon: string) => void;
  onDescriptionChange: (description: string) => void;
  onCoverChange: (cover: EntryCover | null) => void;
  onBodyFocus: () => void;
  titleClassName?: string;
  actions?: ReactNode;
  metadata?: ReactNode;
  coverSize?: "default" | "compact";
}

export function EntryIdentityHeader({
  title,
  icon,
  description,
  cover,
  projectPath,
  spacePath,
  documentPath,
  onTitleChange,
  onIconChange,
  onDescriptionChange,
  onCoverChange,
  onBodyFocus,
  titleClassName,
  actions,
  metadata,
  coverSize = "default",
}: EntryIdentityHeaderProps) {
  return (
    <>
      <CoverBanner
        cover={cover}
        projectPath={projectPath}
        spacePath={spacePath}
        documentPath={documentPath}
        onCoverChange={onCoverChange}
        size={coverSize}
      />
      <div
        className={cn(
          "flex min-w-0 items-start justify-between gap-4",
          titleClassName,
        )}
      >
        <div className="min-w-0 flex-1">
          <TitleZone
            title={title}
            icon={icon}
            description={description}
            onTitleChange={onTitleChange}
            onIconChange={onIconChange}
            onDescriptionChange={onDescriptionChange}
            onBodyFocus={onBodyFocus}
          />
        </div>
        {actions || metadata ? (
          <div className="flex max-w-[22rem] shrink-0 flex-col items-end text-right">
            <div className="flex h-8 items-center justify-end">{actions}</div>
            {metadata}
          </div>
        ) : null}
      </div>
    </>
  );
}

export function EntryIdentityHeaderSkeleton() {
  return (
    <>
      <Skeleton className="h-44 min-h-32 max-h-48 w-full" />
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Skeleton className="size-9 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-8 items-center">
              <Skeleton className="h-6 w-64 max-w-full" />
            </div>
            <div className="flex h-5 items-center">
              <Skeleton className="h-3 w-40 max-w-2/3" />
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end">
          <div className="flex h-8 items-center">
            <Skeleton className="size-7" />
          </div>
          <div className="flex h-5 items-center">
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
      </div>
    </>
  );
}
