import { useCallback } from "react";

import {
  useCollectionItemPeek,
  type CollectionItemPeekScreen,
} from "@/features/collection/app-shell";
import type { CollectionPropertyDefinition } from "@/features/properties";

import {
  agentContextPeekIdentity,
  findAgentContextDetailItem,
  type AgentContextPeekTarget,
} from "../model/detail-items";
import type { AgentContextItem, AgentContextSnapshot } from "../model/types";
import { createAgentContextItemScreen } from "../ui/item-detail";
import { createSkillFileScreen } from "../ui/skill-file-detail";

/**
 * The peek of the "Context": an item, a plugin's component or a skill's file
 * opened in it. It shows the item of each new snapshot and closes once the
 * item, or the skill of the file, is gone.
 */
export function useAgentContextPeek({
  instanceKey,
  onOpenProviders,
  properties,
  snapshot,
}: {
  instanceKey: string;
  onOpenProviders?: () => void;
  properties: readonly CollectionPropertyDefinition<AgentContextItem>[];
  /** Null while the "Context" is not read. */
  snapshot: AgentContextSnapshot | null;
}) {
  const peek = useCollectionItemPeek(agentContextPeekIdentity);
  const items = snapshot?.items ?? null;
  const find = useCallback(
    (target: AgentContextPeekTarget) =>
      items
        ? findAgentContextDetailItem(
            items,
            instanceKey,
            target.kind === "item" ? target : target.skill,
          )
        : null,
    [instanceKey, items],
  );
  const render = useCallback(
    (
      item: AgentContextItem,
      target: AgentContextPeekTarget,
    ): CollectionItemPeekScreen =>
      target.kind === "file"
        ? createSkillFileScreen({
            file: target.file,
            item,
            onClose: () => void peek.close(),
          })
        : createAgentContextItemScreen(item, properties, {
            onOpenProviders,
            peek,
            selection: target,
          }),
    [onOpenProviders, peek, properties],
  );
  return { find, peek, render };
}
