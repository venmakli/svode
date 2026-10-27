import { useCallback, useMemo } from "react";

import {
  useCollectionDetailRowBinding,
  type CollectionDetailController,
  type CollectionDetailRowBinding,
} from "@/features/collection/app-shell";

import type { ActorCatalogSnapshot, ActorCatalogRow } from "../model/types";
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
}): CollectionDetailRowBinding<ActorCatalogRow> {
  const generation = snapshot?.generation ?? 0;
  const createContent = useCallback(
    (row: ActorCatalogRow) =>
      createActorDetailRequest(row, spacePath, generation),
    [generation, spacePath],
  );
  const rows = snapshot?.rows ?? null;
  const findRow = useMemo(
    () =>
      rows
        ? (selection: { rowId: string }) =>
            rows.find((row) => row.canonicalEmail === selection.rowId)
        : null,
    [rows],
  );
  return useCollectionDetailRowBinding({ controller, createContent, findRow });
}
