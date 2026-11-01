import { useCallback, useMemo } from "react";

import {
  useCollectionDetailItemBinding,
  type CollectionDetailController,
  type CollectionDetailItemBinding,
} from "@/features/collection/app-shell";

import type { ActorCatalogSnapshot, ActorCatalogItem } from "../model/types";
import { createActorDetailRequest } from "../ui/actors-presentation";

/** The detail of a person: it shows the person of each new catalog. */
export function useActorDetail({
  controller,
  snapshot,
  spacePath,
}: {
  controller: CollectionDetailController | null;
  /** Null until the catalog is read. */
  snapshot: ActorCatalogSnapshot | null;
  spacePath: string;
}): CollectionDetailItemBinding<ActorCatalogItem> {
  const generation = snapshot?.generation ?? 0;
  const createContent = useCallback(
    (item: ActorCatalogItem) =>
      createActorDetailRequest(item, spacePath, generation),
    [generation, spacePath],
  );
  const items = snapshot?.items ?? null;
  const findItem = useMemo(
    () =>
      items
        ? (selection: { itemId: string }) =>
            items.find((item) => item.canonicalEmail === selection.itemId)
        : null,
    [items],
  );
  return useCollectionDetailItemBinding({
    controller,
    createContent,
    findItem,
  });
}
