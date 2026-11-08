import { useEffect, useRef, useState } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { UserEditScope } from "@/features/navigation";
import { cn } from "@/shared/lib/utils";
import { PeekSheet } from "@/shared/ui/peek-sheet";
import { PeekIdentity, PeekTopBar } from "@/shared/ui/peek-top-bar";

import { ObjectContentHeader } from "./object-content-header";
import type {
  CollectionItemPeekController,
  CollectionItemPeekFocus,
  CollectionItemPeekScreen,
} from "./types";

/**
 * The peek of a domain's items: the Page Peek overlay with the object screen
 * of the shown target.
 *
 * The screen follows the current version of its item: each ready state of the
 * owner's source draws it in place, without opening it again or passing its
 * guard, so scroll, tabs and focus stay. While the source is not ready the
 * shown version stays; once the ready source has no such item the peek closes
 * and focus returns to the item's row or the fallback. Edits in the peek are
 * not edits of the main area object.
 */
export function CollectionItemPeek<Target, Item>({
  peek,
  find,
  render,
  expand,
}: {
  peek: CollectionItemPeekController<Target>;
  /**
   * The current version of the item of `target` in the owner's own ready set,
   * not the items a search leaves visible; undefined when the set has no such
   * item, null while the source is not ready.
   */
  find(target: Target): Item | null | undefined;
  render(item: Item, target: Target): CollectionItemPeekScreen;
  /**
   * "Expand" of a target that opens in the main area, which passes the
   * guards of the peek and the main area; null for a target that does not.
   */
  expand?(target: Target): (() => void) | null;
}) {
  const { target, sessionKey } = peek;
  const found = target === null ? null : find(target);
  const [kept, setKept] = useState<{ item: Item; session: string } | null>(
    null,
  );
  if (
    found !== null &&
    found !== undefined &&
    (kept?.item !== found || kept.session !== sessionKey)
  ) {
    setKept({ item: found, session: sessionKey });
  }
  // A source that is not ready, or a gone item while its close passes the
  // guard, leaves the shown version.
  const item = found ?? (kept?.session === sessionKey ? kept.item : null);
  const screen = target !== null && item !== null ? render(item, target) : null;

  const [closeFocus, setCloseFocus] = useState<CollectionItemPeekFocus>({});
  if (target !== null && closeFocus !== peek.focus) setCloseFocus(peek.focus);

  const gone = target !== null && found === undefined;
  const { close } = peek;
  useEffect(() => {
    if (gone) void close();
  }, [close, gone]);

  return (
    <PeekSheet
      open={target !== null}
      title={screen?.identity.name ?? ""}
      onRequestClose={() => void close()}
      data-collection-item-peek
      onCloseAutoFocus={(event) => {
        if (focusItemPeekTarget(closeFocus)) event.preventDefault();
      }}
    >
      {screen ? (
        <CollectionItemPeekScreenGuard peek={peek} screen={screen} />
      ) : null}
      {screen ? (
        <UserEditScope mainArea={false}>
          <CollectionItemPeekFrame
            screen={screen}
            onExpand={target !== null ? (expand?.(target) ?? null) : null}
            onClose={() => void close()}
          />
        </UserEditScope>
      ) : null}
    </PeekSheet>
  );
}

/** Adds the leave guard of the shown screen while it has one. */
function CollectionItemPeekScreenGuard<Target>({
  peek,
  screen,
}: {
  peek: CollectionItemPeekController<Target>;
  screen: CollectionItemPeekScreen;
}) {
  const canCloseRef = useRef(screen.canClose);
  useEffect(() => {
    canCloseRef.current = screen.canClose;
  });
  const guarded = Boolean(screen.canClose);
  const { registerNavigationGuard } = peek;
  useEffect(() => {
    if (!guarded) return;
    return registerNavigationGuard(
      async () => (await canCloseRef.current?.()) ?? true,
    );
  }, [guarded, registerNavigationGuard]);
  return null;
}

function CollectionItemPeekFrame({
  screen,
  onExpand,
  onClose,
}: {
  screen: CollectionItemPeekScreen;
  onExpand: (() => void) | null;
  onClose(): void;
}) {
  if (screen.layout === "surface") {
    return <div className="flex min-h-0 flex-1 flex-col">{screen.content}</div>;
  }
  // Forms keep the width of their fields; readers fill the peek as a page
  // does.
  const column = cn(
    "w-full min-w-0",
    screen.layout === "form" && "max-w-[30rem]",
  );
  return (
    <>
      <PeekTopBar
        identity={<PeekIdentity {...screen.identity} />}
        info={screen.info}
        menu={screen.menu}
        viewTools={screen.tools}
        openWith={screen.openWith}
        onExpand={onExpand}
        onClose={onClose}
      />
      <ScrollArea
        className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block"
        data-collection-item-peek-scroll
      >
        <div className="px-6 pb-4">
          <div className={cn("flex flex-col gap-4", column)}>
            {screen.header ? <ObjectContentHeader {...screen.header} /> : null}
            {screen.content}
          </div>
        </div>
      </ScrollArea>
      {screen.footer ? (
        <div className="shrink-0 border-t px-6 pt-4">
          <div className={cn("flex", column)}>{screen.footer}</div>
        </div>
      ) : null}
    </>
  );
}

function focusItemPeekTarget(focus: CollectionItemPeekFocus): boolean {
  for (const resolve of [focus.returnFocus, focus.fallbackFocus]) {
    let element: HTMLElement | null | undefined;
    try {
      element = resolve?.();
    } catch {
      continue;
    }
    if (!element || element.isConnected === false) continue;
    try {
      element.focus({ preventScroll: true });
      return true;
    } catch {
      // Try the fallback when the row cannot take focus.
    }
  }
  return false;
}
