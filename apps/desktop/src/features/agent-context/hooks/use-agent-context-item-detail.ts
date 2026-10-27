import { useCallback, useMemo } from "react";

import {
  useCollectionDetailRowBinding,
  type CollectionDetailController,
  type CollectionDetailRowBinding,
} from "@/features/collection/app-shell";
import type { CollectionPropertyDefinition } from "@/features/properties";

import { findAgentContextDetailItem } from "../model/detail-items";
import type { AgentContextItem, AgentContextSnapshot } from "../model/types";
import { createAgentContextItemDetailContent } from "../ui/item-detail";

/**
 * The peek of an item and of a plugin's component opened in it: it shows
 * the item of each new snapshot and closes once the item is gone.
 */
export function useAgentContextItemDetail({
  controller,
  instanceKey,
  onOpenProviders,
  properties,
  snapshot,
}: {
  controller: CollectionDetailController | null;
  instanceKey: string;
  onOpenProviders?: () => void;
  properties: readonly CollectionPropertyDefinition<AgentContextItem>[];
  /** Null while the "Context" is not read. */
  snapshot: AgentContextSnapshot | null;
}): CollectionDetailRowBinding<AgentContextItem> {
  const createContent = useCallback(
    (
      item: AgentContextItem,
      detail: CollectionDetailRowBinding<AgentContextItem>,
    ) =>
      createAgentContextItemDetailContent(item, properties, {
        detail,
        onOpenProviders,
      }),
    [onOpenProviders, properties],
  );
  const findRow = useMemo(
    () =>
      snapshot
        ? (selection: { instanceKey: string; rowId: string }) =>
            findAgentContextDetailItem(snapshot.items, instanceKey, selection)
        : null,
    [instanceKey, snapshot],
  );
  return useCollectionDetailRowBinding({ controller, createContent, findRow });
}
