import { useEffect, useRef, useState } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import type { ScopeMainItem } from "@/features/scope-surfaces";
import { cn } from "@/shared/lib/utils";

import { ObjectContentHeader } from "./object-content-header";
import type { CollectionItemPeekScreen } from "./types";

/**
 * The screen of an item expanded as the main area object: the same parts as
 * in its peek, with breadcrumbs in place of the identity in the top bar.
 *
 * The screen follows the current version of its item as the peek does: each
 * ready state of the owner's source draws it in place, a source that is not
 * ready leaves the shown version, and once the ready source has no such item
 * the host closes it.
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
   * set; undefined when the set has no such item, null while the source is
   * not ready.
   */
  find(target: Target): Item | null | undefined;
  render(item: Item, target: Target): CollectionItemPeekScreen;
}) {
  const found = find(target);
  const [kept, setKept] = useState<Item | null>(null);
  if (found !== null && found !== undefined && kept !== found) setKept(found);
  const item = found ?? kept;
  const screen = item !== null ? render(item, target) : null;

  const gone = found === undefined;
  const { onGone } = main;
  useEffect(() => {
    if (gone) onGone();
  }, [gone, onGone]);

  return (
    <div className="flex min-h-full flex-col" data-collection-item-main>
      {screen ? (
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
