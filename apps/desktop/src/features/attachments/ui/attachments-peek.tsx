import { usePeekNavigation } from "@/features/scope-surfaces";
import { type ReactNode, lazy, Suspense, useEffect, useRef } from "react";
import { Paperclip } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { usePeekStackEntry } from "@/shared/hooks/use-peek-stack-entry";
import { PeekIdentity, PeekTopBar } from "@/shared/ui/peek-top-bar";
import { Skeleton } from "@/components/ui/skeleton";
import { useOpenArtifact } from "@/features/artifact";
import * as m from "@/paraglide/messages.js";
import { cn } from "@/shared/lib/utils";

import { attachmentKindLabel } from "../model/presentation";
import { AttachmentIcon } from "./attachment-icon";
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
  const dismiss = () => {
    navigation.dismiss();
    onOpenChange(false);
  };
  const close = (afterClose?: () => void) =>
    navigation.leave(() => {
      dismiss();
      afterClose?.();
    });
  usePeekStackEntry(Boolean(target), () => void close());
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
          isBinaryViewer ? "pt-2 pb-0" : "pt-2 pb-6",
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
        {target && !isBinaryViewer && !isOwner ? (
          <PeekTopBar
            identity={
              <PeekIdentity
                icon={<AttachmentIcon row={target.row} />}
                name={target.row.displayName}
              />
            }
            onClose={() => void close()}
          />
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
              dismiss={dismiss}
              onExpand={(openFullPage) =>
                void navigation.leave(async () => {
                  if (await openFullPage()) dismiss();
                })
              }
              onClose={() => void close()}
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
