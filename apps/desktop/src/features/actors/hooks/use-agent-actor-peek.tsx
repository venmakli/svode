import {
  useCallback,
  useEffect,
  type Dispatch,
  type SetStateAction,
} from "react";
import { LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { CollectionPresentationRuntime } from "@/features/collection";
import {
  CollectionItemActionsMenu,
  CollectionItemProperties,
  type CollectionItemPeekController,
  type CollectionItemPeekScreen,
} from "@/features/collection/app-shell";
import {
  RepositoryAccessInlineRecovery,
  RepositoryAccessPrimaryButton,
  type RepositoryAccessPreflightController,
} from "@/features/git";
import type { ChatAgents } from "@/features/agent-sessions/agent-settings-popover";
import { AgentAvatar } from "@/features/identity";
import * as m from "@/paraglide/messages.js";

import type { ActorPeekTarget } from "../model/actor-peek";
import { createAgentActorDraft } from "../model/agent-actor-draft";
import type {
  AgentActorAgentOption,
  AgentActorDraft,
  AgentActorItem,
} from "../model/agent-actor-types";
import { AgentActorDetail } from "../ui/agent-actor-detail";
import { agentActorItemId } from "../ui/agent-actors-presentation";
import type { AgentActorEditSession } from "./use-agent-actor-mutations";

/**
 * The screen of an Agent Actor in the peek of the Actors: avatar, name and
 * description, its item actions in ⋯ and its properties in the property
 * panel, followed by its binding row, whose popover keeps
 * the recovery of the binding's agent; its editing form while an edit
 * session of it is open.
 */
export function useAgentActorPeek({
  accessRecovery,
  agents,
  applyMutation,
  editSession,
  mutationPending,
  offers,
  peek,
  readOnly = false,
  items,
  setEditSession,
  onOpenAgentSettings,
  onRecheckOffers,
}: {
  accessRecovery?: RepositoryAccessPreflightController;
  applyMutation(
    kind: "update",
    ownerPath: string,
    draft: AgentActorDraft,
  ): void | Promise<void>;
  agents: readonly AgentActorAgentOption[];
  editSession: AgentActorEditSession | null;
  mutationPending: boolean;
  /** How the chat offers the agents; null while they are read. */
  offers: ChatAgents | null;
  peek: CollectionItemPeekController<ActorPeekTarget>;
  readOnly?: boolean;
  /** The agents of the ready catalog; null until it is read. */
  items: readonly AgentActorItem[] | null;
  setEditSession: Dispatch<SetStateAction<AgentActorEditSession | null>>;
  onOpenAgentSettings(): void;
  onRecheckOffers(): void;
}) {
  // An open form keeps its draft even when its Agent leaves the catalog.
  const editedItem = editSession?.item ?? null;
  const find = useCallback(
    (itemId: string) => {
      if (!items) return null;
      const item = items.find(
        (candidate) => agentActorItemId(candidate) === itemId,
      );
      if (item) return item;
      return editedItem && agentActorItemId(editedItem) === itemId
        ? editedItem
        : undefined;
    },
    [editedItem, items],
  );

  // "Edit" of an Agent opens its form in the peek of the Agent.
  const editedItemId = editedItem ? agentActorItemId(editedItem) : null;
  const { open, target } = peek;
  const shownItemId =
    target?.presentationId === "agents" ? target.itemId : null;
  useEffect(() => {
    if (editedItemId !== null && shownItemId !== editedItemId) {
      open({ presentationId: "agents", itemId: editedItemId });
    }
  }, [editedItemId, open, shownItemId]);

  const render = useCallback(
    (
      item: AgentActorItem,
      presentation: CollectionPresentationRuntime,
    ): CollectionItemPeekScreen => {
      const identity = {
        icon: <AgentAvatar shape="square" size="sm" />,
        name: item.name,
      };
      const session =
        editSession &&
        agentActorItemId(editSession.item) === agentActorItemId(item)
          ? editSession
          : null;
      if (!session) {
        return {
          content: (
            <>
              <CollectionItemProperties
                item={item}
                presentation={presentation}
              />
              <AgentActorDetail
                agents={agents}
                draft={createAgentActorDraft(item.ownerPath, item)}
                editMode={false}
                offers={offers}
                onChange={() => undefined}
                onOpenAgentSettings={onOpenAgentSettings}
                onRecheckOffers={onRecheckOffers}
                onSave={() => undefined}
              />
            </>
          ),
          header: {
            description: item.description || undefined,
            icon: <AgentAvatar shape="square" size="lg" />,
            title: item.name,
          },
          identity,
          menu: (
            <CollectionItemActionsMenu
              item={item}
              presentation={presentation}
            />
          ),
        };
      }
      const accessBlocked =
        Boolean(accessRecovery?.open) &&
        accessRecovery?.pending?.placement === "inline" &&
        accessRecovery.pending?.intentKey === "agent-actor-update-apply";
      return {
        canClose: async () => {
          if (accessBlocked) {
            accessRecovery?.close();
            return false;
          }
          // The Tauri dialog plugin makes window.confirm resolve asynchronously.
          if (
            session.guard.dirty &&
            !(await window.confirm(m.agent_actors_discard_confirm()))
          ) {
            return false;
          }
          session.guard.dirty = false;
          setEditSession((current) => (current === session ? null : current));
          return true;
        },
        content: (
          <div className="flex min-w-0 flex-col gap-4">
            <AgentActorDetail
              agents={agents}
              draft={session.draft}
              editMode={!readOnly}
              offers={offers}
              onChange={(draft) =>
                setEditSession((current) => {
                  if (!current) return current;
                  current.guard.dirty = true;
                  return { ...current, draft };
                })
              }
              onOpenAgentSettings={onOpenAgentSettings}
              onRecheckOffers={onRecheckOffers}
              onSave={(draft) => {
                if (readOnly) return;
                void applyMutation("update", session.item.ownerPath, draft);
              }}
            />
            {accessBlocked ? (
              <RepositoryAccessInlineRecovery recovery={accessRecovery!} />
            ) : null}
          </div>
        ),
        footer: (
          <div className="flex w-full justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={mutationPending}
              onClick={() => {
                if (accessBlocked) {
                  accessRecovery?.close();
                  return;
                }
                accessRecovery?.close();
                session.guard.dirty = false;
                setEditSession(null);
              }}
            >
              {accessBlocked
                ? m.git_access_preflight_cancel()
                : m.agent_actors_cancel()}
            </Button>
            {accessBlocked ? (
              <RepositoryAccessPrimaryButton recovery={accessRecovery!} />
            ) : (
              <Button
                type="submit"
                form={`agent-actor-detail-${session.draft.id}`}
                disabled={mutationPending || readOnly}
              >
                {mutationPending ? (
                  <LoaderCircle
                    data-icon="inline-start"
                    className="animate-spin"
                  />
                ) : null}
                {mutationPending
                  ? m.agent_actors_saving()
                  : m.agent_actors_save()}
              </Button>
            )}
          </div>
        ),
        identity,
        layout: "form",
      };
    },
    [
      accessRecovery,
      agents,
      applyMutation,
      editSession,
      mutationPending,
      offers,
      onOpenAgentSettings,
      onRecheckOffers,
      readOnly,
      setEditSession,
    ],
  );

  return { find, render };
}
