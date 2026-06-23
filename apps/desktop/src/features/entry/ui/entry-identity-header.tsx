import type { ReactNode } from "react";
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
          <div className="mt-1 flex max-w-[22rem] shrink-0 flex-col items-end gap-1 text-right">
            {actions}
            {metadata}
          </div>
        ) : null}
      </div>
    </>
  );
}
