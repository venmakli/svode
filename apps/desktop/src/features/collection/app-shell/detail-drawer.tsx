import {
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { AlertCircle, LoaderCircle, X } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import * as m from "@/paraglide/messages.js";

import {
  CollectionDetailStoreProvider,
  useCollectionDetailStore,
} from "./detail-controller-context";
import {
  createCollectionDetailControllerStore,
  type CollectionDetailActiveState,
} from "./detail-controller";

export const collectionDetailDrawerStyle = {
  bottom: "0.75rem",
  height: "auto",
  maxWidth: "none",
  right: "0.75rem",
  top: "0.75rem",
  width: "min(30rem, calc(100vw - 1.5rem))",
} satisfies CSSProperties;

export function CollectionDetailDrawerProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [store] = useState(() =>
    createCollectionDetailControllerStore({
      guardErrorMessage: m.collection_detail_guard_error(),
    }),
  );

  return (
    <CollectionDetailStoreProvider value={store}>
      {children}
      <CollectionDetailDrawerHost />
    </CollectionDetailStoreProvider>
  );
}

function CollectionDetailDrawerHost() {
  const store = useCollectionDetailDrawerStore();
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const displayed = snapshot.active ?? snapshot.displayed;
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
        data-collection-detail-drawer
        className="data-[side=right]:gap-0 data-[side=right]:overflow-hidden data-[side=right]:rounded-xl data-[side=right]:border"
        style={collectionDetailDrawerStyle}
        onCloseAutoFocus={(event) => {
          if (store.focusAfterClose()) {
            event.preventDefault();
          }
        }}
      >
        <CollectionDetailDrawerFrame
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

export function CollectionDetailDrawerFrame({
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

  return (
    <>
      <SheetHeader className="shrink-0 pr-24">
        <SheetTitle>{request.title}</SheetTitle>
        <SheetDescription>{request.description}</SheetDescription>
      </SheetHeader>
      <div className="absolute right-3 top-3 flex items-center gap-1">
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
      <Separator />
      <ScrollArea
        className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block"
        data-collection-detail-scroll
      >
        <div className="flex min-w-0 flex-col gap-4 p-4">
          {diagnostic ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>{m.collection_detail_guard_error_title()}</AlertTitle>
              <AlertDescription>{diagnostic}</AlertDescription>
            </Alert>
          ) : null}
          {request.content}
        </div>
      </ScrollArea>
      {request.footerActions ? (
        <>
          <Separator />
          <SheetFooter className="mt-0 shrink-0">
            {request.footerActions}
          </SheetFooter>
        </>
      ) : null}
    </>
  );
}

function useCollectionDetailDrawerStore() {
  const store = useCollectionDetailStore();
  return store;
}
