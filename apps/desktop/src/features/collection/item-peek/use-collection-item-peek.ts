import { useCallback, useMemo, useState } from "react";

import { usePeekNavigation } from "@/features/scope-surfaces";

import type { CollectionActivationContext } from "../runtime/model/types";
import type {
  CollectionItemPeekController,
  CollectionItemPeekFocus,
} from "./types";

interface ItemPeekRequest<Target> {
  target: Target;
  focus: CollectionItemPeekFocus;
}

const noFocus: CollectionItemPeekFocus = {};

/**
 * The peek of a domain's items on the Page Peek navigation model: `identity`
 * names the object of a target, so a target of another object passes the
 * leave guard of the shown one once and a target of the same object only
 * shows it again.
 */
export function useCollectionItemPeek<Target>(
  identity: (target: Target) => string,
): CollectionItemPeekController<Target> {
  const [requested, setRequested] = useState<ItemPeekRequest<Target> | null>(
    null,
  );
  const navigation = usePeekNavigation(requested, (request) =>
    identity(request.target),
  );
  const { dismiss, leave, registerNavigationGuard, sessionKey } = navigation;
  const shown = navigation.target;
  const open = useCallback(
    (target: Target, focus: CollectionItemPeekFocus = noFocus) => {
      setRequested({ target, focus });
    },
    [],
  );
  const activation = useCallback(
    <Item>(
      toTarget: (item: Item, context: CollectionActivationContext) => Target,
    ) =>
      (item: Item, context: CollectionActivationContext) => {
        open(toTarget(item, context), {
          fallbackFocus: context.fallbackFocus,
          returnFocus: context.returnFocus,
        });
      },
    [open],
  );
  const close = useCallback(
    () =>
      leave(() => {
        dismiss();
        setRequested(null);
      }, "close"),
    [dismiss, leave],
  );
  return useMemo(
    () => ({
      activation,
      close,
      focus: shown?.focus ?? noFocus,
      open,
      registerNavigationGuard,
      sessionKey,
      target: shown?.target ?? null,
    }),
    [activation, close, open, registerNavigationGuard, sessionKey, shown],
  );
}
