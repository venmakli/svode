import { usePeekNavigation } from "@/features/scope-surfaces";
import { type ReactNode, lazy, Suspense, useEffect, useRef } from "react";
import { Maximize2, Paperclip, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useOpenArtifact } from "@/features/artifact";
import * as m from "@/paraglide/messages.js";
import { cn } from "@/shared/lib/utils";

import { attachmentKindLabel } from "../model/presentation";
import type {
  AttachmentActivationRequest,
  AttachmentOwnerRef,
  AttachmentOwnerPeekRenderer,
  AttachmentOwnerPeekContext,
  AttachmentRow,
} from "../model/types";

const DocumentSurface = lazy(async () => {
  const module = await import("@/features/document/app-shell");
  return { default: module.DocumentSurface };
});

const MediaSurface = lazy(async () => {
  const module = await import("@/features/media/app-shell");
  return { default: module.MediaSurface };
});

export function AttachmentsPeek({
  owner,
  target: requestedTarget,
  onOpenChange,
  renderOwnerPeek,
  directoryContent,
  onContentPathChange,
}: {
  directoryContent?: ReactNode;
  onContentPathChange?: (path: string) => void;
  owner: AttachmentOwnerRef;
  readOnly: boolean;
  target: AttachmentActivationRequest | null;
  onOpenChange(open: boolean): void;
  renderOwnerPeek: AttachmentOwnerPeekRenderer;
}) {
  const navigation = usePeekNavigation(
    requestedTarget,
    (next) =>
      `${next.owner.spacePath}:${next.ownerSession?.key ?? next.row.key}`,
  );
  const target = navigation.target;
  const registerCloseGuard = navigation.registerNavigationGuard;
  const close = (afterClose?: () => void) =>
    navigation.leave(() => {
      navigation.dismiss();
      onOpenChange(false);
      afterClose?.();
    });
  const activationRef = useRef(target?.activation);
  useEffect(() => {
    if (target) activationRef.current = target.activation;
  }, [target]);
  const openArtifact = useOpenArtifact();
  const resolvedSpacePath = target?.owner.spacePath ?? owner.spacePath;
  const resolvedProjectPath = target?.owner.projectPath ?? owner.projectPath;
  const isOwner =
    Boolean(target?.ownerSession) ||
    target?.row.kind === "page" ||
    target?.row.kind === "collection" ||
    target?.row.kind === "app";
  const isDocument = target?.row.kind === "document";
  const isMedia = target?.row.kind === "media";
  const isBinaryViewer = isDocument || isMedia;

  return (
    <Sheet
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        overlayClassName="bg-black/25 backdrop-blur-none supports-backdrop-filter:backdrop-blur-none"
        className={cn(
          "gap-0 p-0 data-[side=right]:sm:max-w-none",
          isBinaryViewer ? "pt-0 pb-0" : "pt-2 pb-6",
        )}
        style={{ width: "min(1120px, max(720px, 66vw), 94vw)" }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreAttachmentFocus(activationRef.current);
        }}
      >
        <SheetTitle className="sr-only">
          {target?.row.displayName ?? m.scope_surface_attachments()}
        </SheetTitle>
        {!isBinaryViewer && !isOwner ? (
          <div className="flex shrink-0 items-center justify-end gap-1 px-2 pb-2">
            <PeekActions onClose={() => void close()} />
          </div>
        ) : null}
        <div
          className={cn(
            "min-h-0 flex-1 overflow-x-hidden",
            isBinaryViewer
              ? "overflow-hidden"
              : isOwner
                ? "overflow-hidden"
                : "scrollbar-hide overflow-y-auto",
          )}
        >
          {target?.row.kind === "directory" ? (
            directoryContent
          ) : isOwner && target ? (
            <OwnerPeekContent
              renderOwnerPeek={renderOwnerPeek}
              target={target}
              spaceId={target.owner.spaceId ?? owner.spaceId}
              registerCloseGuard={registerCloseGuard}
              onContentPathChange={onContentPathChange}
              renderActions={(onOpenFullPage) => (
                <PeekActions
                  onClose={() => void close()}
                  onExpand={() =>
                    void navigation.leave(async () => {
                      if (await onOpenFullPage()) {
                        navigation.dismiss();
                        onOpenChange(false);
                      }
                    })
                  }
                />
              )}
            />
          ) : target?.row.kind === "document" ? (
            <Suspense fallback={<DocumentPeekLoadingState />}>
              <DocumentSurface
                path={target.row.path}
                projectPath={resolvedProjectPath}
                spaceId={target.owner.spaceId}
                spacePath={resolvedSpacePath}
                onClose={() => onOpenChange(false)}
                onOpenFullPage={() => {
                  onOpenChange(false);
                  openArtifact({
                    path: target.row.path,
                    sourceShape: target.row.sourceShape,
                    spaceId: target.owner.spaceId,
                  });
                }}
                renderToolbarActions={(actions) => (
                  <PeekActions
                    onClose={actions.onClose}
                    onExpand={actions.onOpenFullPage}
                  />
                )}
              />
            </Suspense>
          ) : target?.row.kind === "media" ? (
            <Suspense fallback={<MediaPeekLoadingState />}>
              <MediaSurface
                path={target.row.path}
                projectPath={resolvedProjectPath}
                spaceId={target.owner.spaceId}
                spacePath={resolvedSpacePath}
                onClose={() => onOpenChange(false)}
                onOpenFullPage={() => {
                  onOpenChange(false);
                  openArtifact({
                    path: target.row.path,
                    sourceShape: target.row.sourceShape,
                    spaceId: target.owner.spaceId,
                  });
                }}
                renderToolbarActions={(actions) => (
                  <PeekActions
                    onClose={actions.onClose}
                    onExpand={actions.onOpenFullPage}
                  />
                )}
              />
            </Suspense>
          ) : target ? (
            <BinaryAvailability row={target.row} />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function PeekActions({
  onClose,
  onExpand,
}: {
  onClose(): void;
  onExpand?: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {onExpand ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 rounded-lg px-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={onExpand}
        >
          <Maximize2 data-icon="inline-start" />
          {m.attachments_full_page()}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground hover:text-foreground"
        onClick={onClose}
      >
        <X />
        <span className="sr-only">{m.settings_cancel()}</span>
      </Button>
    </div>
  );
}

function DocumentPeekLoadingState() {
  return (
    <div
      className="flex flex-col gap-4 px-6 py-8"
      aria-label={m.document_loading()}
    >
      <Skeleton className="h-10 w-2/3" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

function MediaPeekLoadingState() {
  return (
    <div
      className="flex flex-col gap-4 px-6 py-8"
      aria-label={m.media_loading()}
    >
      <Skeleton className="h-10 w-2/3" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

function BinaryAvailability({ row }: { row: AttachmentRow }) {
  return (
    <Empty className="min-h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Paperclip />
        </EmptyMedia>
        <EmptyTitle>{row.displayName}</EmptyTitle>
        <EmptyDescription>
          {m.attachments_binary_unavailable({
            type: attachmentKindLabel(row),
          })}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function restoreAttachmentFocus(
  activation: AttachmentActivationRequest["activation"] | undefined,
) {
  queueMicrotask(() => {
    const target = activation?.returnFocus?.() ?? activation?.fallbackFocus?.();
    target?.focus();
  });
}

function OwnerPeekContent({
  renderOwnerPeek,
  ...context
}: AttachmentOwnerPeekContext & {
  renderOwnerPeek: AttachmentOwnerPeekRenderer;
}) {
  return renderOwnerPeek(context);
}
