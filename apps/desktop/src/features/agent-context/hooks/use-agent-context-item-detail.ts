import { useCallback, useMemo } from "react";

import {
  useCollectionDetailItemBinding,
  type CollectionDetailController,
  type CollectionDetailItemBinding,
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
}): CollectionDetailItemBinding<AgentContextItem> {
  const createContent = useCallback(
    (
      item: AgentContextItem,
      detail: CollectionDetailItemBinding<AgentContextItem>,
    ) =>
      createAgentContextItemDetailContent(item, properties, {
        detail,
        onOpenProviders,
      }),
    [onOpenProviders, properties],
  );
  const findItem = useMemo(
    () =>
      snapshot
        ? (selection: { instanceKey: string; itemId: string }) =>
            findAgentContextDetailItem(snapshot.items, instanceKey, selection)
        : null,
    [instanceKey, snapshot],
  );
  return useCollectionDetailItemBinding({
    controller,
    createContent,
    findItem,
  });
}
