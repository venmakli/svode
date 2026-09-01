import type { ComponentProps, ReactNode, Ref } from "react";

import { CardContent } from "@/components/ui/card";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/shared/lib/utils";

import type { CollectionGalleryCardDensity } from "../model/presentation-layout";
import { isCollectionPresentationInteractiveTarget } from "./presentation-chrome";
import { CollectionCardShell } from "./presentation-layout";

type GalleryMoveKey =
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "End"
  | "Home";

export interface CollectionPresentationGalleryCardProps extends Omit<
  ComponentProps<typeof CollectionCardShell>,
  | "children"
  | "contextMenu"
  | "density"
  | "onClick"
  | "onDoubleClick"
  | "onFocus"
  | "onKeyDown"
  | "ref"
  | "title"
> {
  cardRef?: Ref<HTMLDivElement>;
  contextMenu?: ReactNode;
  contextMenuClassName?: string;
  cover?: ReactNode;
  density: CollectionGalleryCardDensity;
  description?: ReactNode;
  diagnostic?: ReactNode;
  leading?: ReactNode;
  onDoubleOpen?(): void;
  onFocusCard?(): void;
  onMoveFocus?(key: GalleryMoveKey): void;
  onOpen?(): void;
  overlays?: ReactNode;
  properties?: ReactNode;
  title?: ReactNode;
  onClick?: ComponentProps<typeof CollectionCardShell>["onClick"];
  onDoubleClick?: ComponentProps<typeof CollectionCardShell>["onDoubleClick"];
  onFocus?: ComponentProps<typeof CollectionCardShell>["onFocus"];
  onKeyDown?: ComponentProps<typeof CollectionCardShell>["onKeyDown"];
}

export function CollectionPresentationGalleryCard({
  cardRef,
  className,
  contextMenu,
  contextMenuClassName,
  cover,
  density,
  description,
  diagnostic,
  leading,
  onClick,
  onDoubleClick,
  onDoubleOpen,
  onFocus,
  onFocusCard,
  onKeyDown,
  onMoveFocus,
  onOpen,
  overlays,
  properties,
  title,
  ...props
}: CollectionPresentationGalleryCardProps) {
  const card = (
    <CollectionCardShell
      {...props}
      ref={cardRef}
      size={density === "compact" ? "sm" : "default"}
      className={cn((onOpen || onDoubleOpen) && "cursor-pointer", className)}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          isCollectionPresentationInteractiveTarget(event)
        ) {
          return;
        }
        event.currentTarget.focus();
        onOpen?.();
      }}
      onDoubleClick={(event) => {
        onDoubleClick?.(event);
        if (
          event.defaultPrevented ||
          isCollectionPresentationInteractiveTarget(event)
        ) {
          return;
        }
        onDoubleOpen?.();
      }}
      onFocus={(event) => {
        onFocus?.(event);
        if (!event.defaultPrevented) onFocusCard?.();
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (
          event.defaultPrevented ||
          isCollectionPresentationInteractiveTarget(event)
        ) {
          return;
        }
        if (isGalleryMoveKey(event.key)) {
          event.preventDefault();
          onMoveFocus?.(event.key);
        } else if (onOpen && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onOpen();
        } else if (event.key === "Escape") {
          event.currentTarget.blur();
        }
      }}
    >
      {overlays}
      {cover}
      <CardContent
        className={cn(
          "flex flex-1 flex-col",
          density === "compact" ? "gap-1.5 px-2.5 py-2.5" : "gap-2 p-3",
        )}
      >
        {title !== undefined || leading !== undefined ? (
          <div className="flex min-w-0 items-start gap-1.5">
            {leading !== undefined ? (
              <div className="flex min-w-4 shrink-0 items-center justify-center">
                {leading}
              </div>
            ) : null}
            {title !== undefined ? (
              <div
                className={cn(
                  "line-clamp-2 min-w-0 font-medium leading-snug",
                  density === "compact" ? "text-[13px]" : "text-sm",
                )}
              >
                {title}
              </div>
            ) : null}
          </div>
        ) : null}
        {description !== undefined && description !== null ? (
          <div
            className={cn(
              "text-xs text-muted-foreground",
              density === "compact" ? "truncate" : "line-clamp-3",
            )}
          >
            {description}
          </div>
        ) : null}
        {properties}
        {diagnostic}
      </CardContent>
    </CollectionCardShell>
  );

  if (!contextMenu) return card;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <ContextMenuContent className={cn("w-56", contextMenuClassName)}>
        {contextMenu}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function isGalleryMoveKey(key: string): key is GalleryMoveKey {
  return (
    key === "ArrowDown" ||
    key === "ArrowLeft" ||
    key === "ArrowRight" ||
    key === "ArrowUp" ||
    key === "End" ||
    key === "Home"
  );
}
