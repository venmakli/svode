import { FileWarning, Maximize2, Paperclip, X } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { PagePeekSurface } from "@/features/page/detail";
import { useOpenPage } from "@/features/page/navigation";
import type { ScopeOwnerRef } from "@/features/scope-surfaces";
import * as m from "@/paraglide/messages.js";

import { useAttachmentPagePeek } from "../hooks/use-attachment-page-peek";
import { attachmentKindLabel } from "../model/presentation";
import type {
  AttachmentActivationRequest,
  AttachmentRow,
} from "../model/types";

export function AttachmentsPeek({
  owner,
  readOnly,
  target,
  onOpenChange,
}: {
  owner: ScopeOwnerRef;
  readOnly: boolean;
  target: AttachmentActivationRequest | null;
  onOpenChange(open: boolean): void;
}) {
  const openPage = useOpenPage();
  const resolvedSpacePath = target?.owner.spacePath ?? owner.spacePath;
  const resolvedProjectPath = target?.owner.projectPath ?? owner.projectPath;
  const page = useAttachmentPagePeek({
    row: target?.row ?? null,
    spaceId: owner.spaceId,
    spacePath: resolvedSpacePath,
  });
  const loadedPage = page.state.phase === "ready" ? page.state.page : null;

  return (
    <Sheet open={Boolean(target)} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        overlayClassName="bg-black/25 backdrop-blur-none supports-backdrop-filter:backdrop-blur-none"
        className="gap-0 p-0 pt-2 pb-6 data-[side=right]:sm:max-w-none"
        style={{ width: "min(1120px, max(720px, 66vw), 94vw)" }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreAttachmentFocus(target?.activation);
        }}
      >
        <SheetTitle className="sr-only">
          {target?.row.displayName ?? m.scope_surface_attachments()}
        </SheetTitle>
        <div className="flex shrink-0 items-center justify-end gap-1 px-2 pb-2">
          {loadedPage ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 rounded-lg px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                onOpenChange(false);
                openPage(loadedPage.path, owner.spaceId);
              }}
            >
              <Maximize2 data-icon="inline-start" />
              {m.attachments_full_page()}
            </Button>
          ) : null}
          <SheetClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground"
            >
              <X />
              <span className="sr-only">{m.settings_cancel()}</span>
            </Button>
          </SheetClose>
        </div>
        <div className="scrollbar-hide min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          {target?.row.kind === "page" ? (
            page.state.phase === "ready" ? (
              <PagePeekSurface
                readOnly={readOnly}
                page={page.state.page}
                schemaResult={page.state.schemaResult}
                spacePath={resolvedSpacePath}
                projectPath={resolvedProjectPath}
                spaceId={owner.spaceId}
                pagePathHandoff={page.state.pathHandoff}
                onOpenPath={(path, spaceId) =>
                  openPage(path, spaceId ?? owner.spaceId)
                }
                onPageChange={(update) =>
                  page.setState((current) => {
                    if (current.phase !== "ready") return current;
                    const nextPage =
                      typeof update === "function"
                        ? update(current.page)
                        : update;
                    return nextPage ? { ...current, page: nextPage } : current;
                  })
                }
                onSchemaChange={(schemaResult) =>
                  page.setState((current) =>
                    current.phase === "ready"
                      ? { ...current, schemaResult }
                      : current,
                  )
                }
              />
            ) : page.state.phase === "error" ? (
              <div className="px-6 py-4">
                <Alert variant="destructive">
                  <FileWarning />
                  <AlertDescription>{page.state.message}</AlertDescription>
                  <Button size="sm" variant="outline" onClick={page.retry}>
                    {m.attachments_retry()}
                  </Button>
                </Alert>
              </div>
            ) : (
              <div className="space-y-4 px-6 py-8">
                <Skeleton className="h-10 w-2/3" />
                <Skeleton className="h-48 w-full" />
              </div>
            )
          ) : target ? (
            <BinaryAvailability row={target.row} />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
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
            type: attachmentKindLabel(row.kind),
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
