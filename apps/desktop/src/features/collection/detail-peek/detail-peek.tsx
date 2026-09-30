import { useSyncExternalStore } from "react";
import { AlertCircle, LoaderCircle, X } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { registerSupplementalContentDeactivation } from "@/features/artifact";
import { usePeekStackEntry } from "@/shared/hooks/use-peek-stack-entry";
import { cn } from "@/shared/lib/utils";
import * as m from "@/paraglide/messages.js";

import {
  createCollectionDetailControllerStore,
  type CollectionDetailActiveState,
} from "./detail-controller";
import type { CollectionDetailController } from "./types";

/** The detail of a fixed Collection row joins the navigation guards. */
const collectionDetailStore = createCollectionDetailControllerStore({
  guardErrorMessage: () => m.collection_detail_guard_error(),
  registerNavigationGuard: (guard) =>
    registerSupplementalContentDeactivation(async () =>
      (await guard()) ? "ready" : "blocked",
    ),
});

export const collectionDetailController: CollectionDetailController =
  collectionDetailStore.controller;

export function useCollectionDetailController(): CollectionDetailController {
  return collectionDetailController;
}

/** Row detail of fixed Collections in the Page Peek pattern. */
export function CollectionDetailPeekHost() {
  const store = collectionDetailStore;
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const displayed = snapshot.active ?? snapshot.displayed;
  usePeekStackEntry(snapshot.active !== null, () => {
    if (displayed) void store.controller.close(displayed.request.selection);
  });
  if (!displayed) {
    return null;
  }

  return (
    <Sheet
      open={snapshot.active !== null}
      onOpenChange={(open) => {
        if (!open) {
          void store.controller.close(displayed.request.selection);
        }
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        data-collection-detail-peek
        overlayClassName="bg-black/25 backdrop-blur-none supports-backdrop-filter:backdrop-blur-none"
        className="gap-0 p-0 pt-2 pb-6 data-[side=right]:sm:max-w-none"
        style={{ width: "min(1120px, max(720px, 66vw), 94vw)" }}
        onCloseAutoFocus={(event) => {
          if (store.focusAfterClose()) {
            event.preventDefault();
          }
        }}
      >
        <CollectionDetailPeekFrame
          active={displayed}
          diagnostic={snapshot.diagnostic}
          pending={snapshot.pending}
          onClose={() => {
            void store.controller.close(displayed.request.selection);
          }}
        />
      </SheetContent>
    </Sheet>
  );
}

export function CollectionDetailPeekFrame({
  active,
  diagnostic,
  pending,
  onClose,
}: {
  active: CollectionDetailActiveState;
  diagnostic: string | null;
  pending: boolean;
  onClose(): void;
}) {
  const { request } = active;
  // Forms keep the width of their fields; readers keep a readable line.
  const column = cn(
    "w-full min-w-0",
    request.layout === "form" ? "max-w-[30rem]" : "max-w-3xl",
  );

  return (
    <>
      <div className="flex shrink-0 items-center justify-end gap-1 px-2 pb-2">
        {request.headerActions}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={m.collection_detail_close()}
          disabled={pending}
          onClick={onClose}
        >
          {pending ? <LoaderCircle className="animate-spin" /> : <X />}
        </Button>
      </div>
      <SheetHeader className="shrink-0 px-6 pt-0 pb-3">
        <div className={cn("flex flex-col gap-0.5", column)}>
          <SheetTitle className="text-lg font-semibold">
            {request.title}
          </SheetTitle>
          <SheetDescription>{request.description}</SheetDescription>
        </div>
      </SheetHeader>
      <ScrollArea
        className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block"
        data-collection-detail-scroll
      >
        <div className="px-6 pb-4">
          <div className={cn("flex flex-col gap-4", column)}>
            {diagnostic ? (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertTitle>
                  {m.collection_detail_guard_error_title()}
                </AlertTitle>
                <AlertDescription>{diagnostic}</AlertDescription>
              </Alert>
            ) : null}
            {request.content}
          </div>
        </div>
      </ScrollArea>
      {request.footerActions ? (
        <div className="shrink-0 border-t px-6 pt-4">
          <div className={cn("flex", column)}>{request.footerActions}</div>
        </div>
      ) : null}
    </>
  );
}
