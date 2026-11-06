import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import type { ScopeMainItem } from "@/features/scope-surfaces";
import * as m from "@/paraglide/messages.js";
import { cn } from "@/shared/lib/utils";

import { ObjectContentHeader } from "./object-content-header";
import type { CollectionItemPeekScreen } from "./types";

/**
 * What `find` of an expanded item returns when the owner's ready set has no
 * such item but its read is incomplete: the read may have lost the item, so
 * it is not gone.
 */
export const COLLECTION_ITEM_UNREAD: unique symbol = Symbol(
  "collection-item-unread",
);

/**
 * The screen of an item expanded as the main area object: the same parts as
 * in its peek, with breadcrumbs in place of the identity in the top bar.
 *
 * The screen follows the current version of its item as the peek does: each
 * ready state of the owner's source draws it in place, a source that is not
 * ready leaves the shown version, and once a complete read has no such item
 * the host closes it. While an incomplete read lacks the item, the screen
 * says so and offers the owner's tab; a later read that has it draws it.
 */
export function CollectionItemMain<Target, Item>({
  main,
  target,
  find,
  render,
}: {
  main: ScopeMainItem;
  target: Target;
  /**
   * The current version of the item of `target` in the owner's own ready
   * set; undefined when a complete read of the set has no such item,
   * `COLLECTION_ITEM_UNREAD` when an incomplete one has none, null while the
   * source is not ready.
   */
  find(target: Target): Item | null | undefined | typeof COLLECTION_ITEM_UNREAD;
  render(item: Item, target: Target): CollectionItemPeekScreen;
}) {
  const found = find(target);
  // The last version or unread outcome stays while the source is not ready.
  const [kept, setKept] = useState<Item | typeof COLLECTION_ITEM_UNREAD | null>(
    null,
  );
  if (found !== null && found !== undefined && kept !== found) setKept(found);
  const shown = found ?? kept;
  const unread = shown === COLLECTION_ITEM_UNREAD;
  const screen =
    shown !== null && shown !== COLLECTION_ITEM_UNREAD
      ? render(shown, target)
      : null;

  const gone = found === undefined;
  const { onGone } = main;
  useEffect(() => {
    if (gone) onGone();
  }, [gone, onGone]);

  return (
    <div className="flex min-h-full flex-col" data-collection-item-main>
      {unread ? (
        <CollectionItemMainUnread main={main} />
      ) : screen ? (
        <>
          <CollectionItemMainGuard main={main} screen={screen} />
          {main.renderTopBar({
            identity: screen.identity,
            info: screen.info,
            menu: screen.menu,
            tools: screen.tools,
            openWith: screen.openWith,
          })}
          <CollectionItemMainFrame screen={screen} />
        </>
      ) : (
        <div className="flex flex-col gap-4 px-6 py-4" aria-busy>
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      )}
    </div>
  );
}

/** An item its owner's source cannot read now, with the way to its tab. */
function CollectionItemMainUnread({ main }: { main: ScopeMainItem }) {
  return (
    <Empty data-collection-item-unread>
      <EmptyHeader>
        <EmptyDescription>{m.collection_item_main_unread()}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={main.openSurface}
        >
          {m.collection_item_main_open_surface({ surface: main.surfaceLabel })}
        </Button>
      </EmptyContent>
    </Empty>
  );
}

/** Adds the leave guard of the shown screen while it has one. */
function CollectionItemMainGuard({
  main,
  screen,
}: {
  main: ScopeMainItem;
  screen: CollectionItemPeekScreen;
}) {
  const canCloseRef = useRef(screen.canClose);
  useEffect(() => {
    canCloseRef.current = screen.canClose;
  });
  const guarded = Boolean(screen.canClose);
  const { registerNavigationGuard } = main;
  useEffect(() => {
    if (!guarded) return;
    return registerNavigationGuard(
      async () => (await canCloseRef.current?.()) ?? true,
    );
  }, [guarded, registerNavigationGuard]);
  return null;
}

function CollectionItemMainFrame({
  screen,
}: {
  screen: CollectionItemPeekScreen;
}) {
  if (screen.layout === "surface") {
    return <div className="flex min-h-0 flex-1 flex-col">{screen.content}</div>;
  }
  const column = cn(
    "w-full min-w-0",
    screen.layout === "form" ? "max-w-[30rem]" : "max-w-5xl",
  );
  return (
    <div className="flex flex-col gap-4 px-6 pb-4">
      <div className={cn("flex flex-col gap-4", column)}>
        {screen.header ? <ObjectContentHeader {...screen.header} /> : null}
        {screen.content}
      </div>
      {screen.footer ? (
        <div className={cn("flex border-t pt-4", column)}>{screen.footer}</div>
      ) : null}
    </div>
  );
}
