import { useCallback } from "react";

import type { CollectionPresentationRuntime } from "@/features/collection";

import type { ActorCatalogSnapshot, ActorCatalogItem } from "../model/types";
import { createActorScreen } from "../ui/actors-presentation";

/** The screen of a person in the peek of the Actors, by canonical email. */
export function useActorPeek({
  snapshot,
  spacePath,
}: {
  /** Null until the catalog is read. */
  snapshot: ActorCatalogSnapshot | null;
  spacePath: string;
}) {
  const generation = snapshot?.generation ?? 0;
  const items = snapshot?.items ?? null;
  const find = useCallback(
    (canonicalEmail: string) =>
      items
        ? items.find((item) => item.canonicalEmail === canonicalEmail)
        : null,
    [items],
  );
  const render = useCallback(
    (item: ActorCatalogItem, presentation: CollectionPresentationRuntime) =>
      createActorScreen(item, presentation, spacePath, generation),
    [generation, spacePath],
  );
  return { find, render };
}
