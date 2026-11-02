import { useCallback } from "react";

import type { CollectionPresentationRuntime } from "@/features/collection";
import {
  CollectionItemActionsMenu,
  CollectionItemProperties,
  type CollectionItemPeekScreen,
} from "@/features/collection/app-shell";
import type { CollectionPropertyActionState } from "@/features/properties";
import { AgentAvatar } from "@/features/identity";

import type {
  AgentActorItem,
  AgentActorState,
} from "../model/agent-actor-types";
import { agentActorItemId } from "../ui/agent-actors-presentation";

/**
 * The screen of an Agent Actor (Stage 11 `04`, 4.I): avatar and name in the
 * top bar with its item actions in ⋯, then the content header with the name
 * and the description edited in place, then its properties in the property
 * panel; it has no body. An Agent that cannot be edited shows the header
 * and the panel read-only, with the reason at "Agent".
 */
export function useAgentActorPeek({
  editState,
  focusTitleRequest,
  items,
  write,
}: {
  /** Whether the Agent can be edited now. */
  editState(item: AgentActorItem): CollectionPropertyActionState;
  /** An Agent just created, whose name takes focus once. */
  focusTitleRequest: { itemId: string; request: number } | null;
  /** The agents of the ready catalog; null until it is read. */
  items: readonly AgentActorItem[] | null;
  write(
    item: AgentActorItem,
    change: (state: AgentActorState) => AgentActorState,
  ): Promise<void>;
}) {
  const find = useCallback(
    (itemId: string) => {
      if (!items) return null;
      return items.find((candidate) => agentActorItemId(candidate) === itemId);
    },
    [items],
  );

  const render = useCallback(
    (
      item: AgentActorItem,
      presentation: CollectionPresentationRuntime,
    ): CollectionItemPeekScreen => {
      const itemId = agentActorItemId(item);
      const state = editState(item).status;
      const editable = state === "idle" || state === "pending";
      return {
        content: (
          <CollectionItemProperties item={item} presentation={presentation} />
        ),
        header: {
          description: item.description || undefined,
          edit: editable
            ? {
                description: item.description ?? "",
                titleFocusRequest:
                  focusTitleRequest?.itemId === itemId
                    ? focusTitleRequest.request
                    : undefined,
                onTitleCommit: (name) =>
                  write(item, (current) => ({ ...current, name })),
                onDescriptionCommit: (description) =>
                  write(item, (current) => ({
                    ...current,
                    description: description || null,
                  })),
              }
            : undefined,
          icon: <AgentAvatar shape="square" size="lg" />,
          title: item.name,
        },
        identity: {
          icon: <AgentAvatar shape="square" size="sm" />,
          name: item.name,
        },
        menu: (
          <CollectionItemActionsMenu item={item} presentation={presentation} />
        ),
      };
    },
    [editState, focusTitleRequest, write],
  );

  return { find, render };
}
