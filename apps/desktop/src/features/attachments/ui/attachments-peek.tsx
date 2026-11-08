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
import { PeekSheet } from "@/shared/ui/peek-sheet";
import { PeekIdentity, PeekTopBar } from "@/shared/ui/peek-top-bar";
import { Skeleton } from "@/components/ui/skeleton";
import { useOpenArtifact } from "@/features/artifact";
import { ChangesControl, fileChangesTarget } from "@/features/changes";
import * as m from "@/paraglide/messages.js";
import { cn } from "@/shared/lib/utils";

import { attachmentKindLabel } from "../model/presentation";
import { AttachmentIcon } from "./attachment-icon";
import type {
  AttachmentActivationRequest,
  AttachmentOwnerRef,
  AttachmentOwnerPeekRenderer,
  AttachmentOwnerPeekContext,
  AttachmentItem,
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
      `${next.owner.spacePath}:${next.ownerSession?.key ?? next.item.key}`,
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
    }, "close");
  const activationRef = useRef(target?.activation);
  useEffect(() => {
    if (target) activationRef.current = target.activation;
  }, [target]);
  const openArtifact = useOpenArtifact();
  const resolvedSpacePath = target?.owner.spacePath ?? owner.spacePath;
  const resolvedProjectPath = target?.owner.projectPath ?? owner.projectPath;
  const isOwner =
    Boolean(target?.ownerSession) ||
    target?.item.kind === "page" ||
    target?.item.kind === "collection" ||
    target?.item.kind === "app";
  const isDocument = target?.item.kind === "document";
  const isMedia = target?.item.kind === "media";
  const isBinaryViewer = isDocument || isMedia;
  const fileChanges =
    target && isBinaryViewer ? (
      <ChangesControl
        origin="peek"
        target={fileChangesTarget({
          spacePath: resolvedSpacePath,
          projectPath: resolvedProjectPath,
          path: target.item.path,
        })}
      />
    ) : null;

  return (
    <PeekSheet
      open={Boolean(target)}
      title={target?.item.displayName ?? m.scope_surface_attachments()}
      onRequestClose={() => void close()}
      className={isBinaryViewer ? "pb-0" : undefined}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        restoreAttachmentFocus(activationRef.current);
      }}
    >
      {target && !isBinaryViewer && !isOwner ? (
        <PeekTopBar
          identity={
            <PeekIdentity
              icon={<AttachmentIcon item={target.item} />}
              name={target.item.displayName}
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
        {target?.item.kind === "directory" ? (
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
              }, "expand")
            }
            onClose={() => void close()}
          />
        ) : target?.item.kind === "document" ? (
          <Suspense fallback={<DocumentPeekLoadingState />}>
            <DocumentSurface
              path={target.item.path}
              projectPath={resolvedProjectPath}
              spaceId={target.owner.spaceId}
              spacePath={resolvedSpacePath}
              changes={fileChanges}
              onClose={() => onOpenChange(false)}
              onOpenFullPage={() => {
                onOpenChange(false);
                openArtifact({
                  path: target.item.path,
                  sourceShape: target.item.sourceShape,
                  spaceId: target.owner.spaceId,
                });
              }}
            />
          </Suspense>
        ) : target?.item.kind === "media" ? (
          <Suspense fallback={<MediaPeekLoadingState />}>
            <MediaSurface
              path={target.item.path}
              projectPath={resolvedProjectPath}
              spaceId={target.owner.spaceId}
              spacePath={resolvedSpacePath}
              changes={fileChanges}
              onClose={() => onOpenChange(false)}
              onOpenFullPage={() => {
                onOpenChange(false);
                openArtifact({
                  path: target.item.path,
                  sourceShape: target.item.sourceShape,
                  spaceId: target.owner.spaceId,
                });
              }}
            />
          </Suspense>
        ) : target ? (
          <BinaryAvailability item={target.item} />
        ) : null}
      </div>
    </PeekSheet>
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

function BinaryAvailability({ item }: { item: AttachmentItem }) {
  return (
    <Empty className="min-h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Paperclip />
        </EmptyMedia>
        <EmptyTitle>{item.displayName}</EmptyTitle>
        <EmptyDescription>
          {m.attachments_binary_unavailable({
            type: attachmentKindLabel(item),
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
