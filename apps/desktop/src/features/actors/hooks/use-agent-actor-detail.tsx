import {
  useCallback,
  useEffect,
  useMemo,
  type Dispatch,
  type SetStateAction,
} from "react";
import { LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  useCollectionDetailItemBinding,
  type CollectionDetailContent,
  type CollectionDetailController,
  type CollectionDetailItemBinding,
} from "@/features/collection/app-shell";
import {
  RepositoryAccessInlineRecovery,
  RepositoryAccessPrimaryButton,
  type RepositoryAccessPreflightController,
} from "@/features/git";
import type { ChatAgents } from "@/features/agent-sessions/agent-settings-popover";
import { AgentAvatar } from "@/features/identity";
import * as m from "@/paraglide/messages.js";

import { createAgentActorDraft } from "../model/agent-actor-draft";
import type {
  AgentActorAgentOption,
  AgentActorDraft,
  AgentActorItem,
} from "../model/agent-actor-types";
import { AgentActorDetail } from "../ui/agent-actor-detail";
import { agentActorItemId } from "../ui/agent-actors-presentation";
import type { AgentActorEditSession } from "./use-agent-actor-mutations";

export function useAgentActorDetail({
  accessRecovery,
  agents,
  applyMutation,
  detailController,
  editSession,
  instanceKey,
  mutationPending,
  offers,
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
  detailController: CollectionDetailController | null;
  editSession: AgentActorEditSession | null;
  instanceKey: string;
  mutationPending: boolean;
  /** How the chat offers the agents; null while they are read. */
  offers: ChatAgents | null;
  readOnly?: boolean;
  /** The agents of the ready catalog; null until it is read. */
  items: readonly AgentActorItem[] | null;
  setEditSession: Dispatch<SetStateAction<AgentActorEditSession | null>>;
  onOpenAgentSettings(): void;
  onRecheckOffers(): void;
}): CollectionDetailItemBinding<AgentActorItem> {
  const createReadOnlyDetail = useCallback(
    (item: AgentActorItem): CollectionDetailContent => ({
      content: (
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
      ),
      description: (
        <span className="sr-only">{m.agent_actors_detail_description()}</span>
      ),
      title: detailTitle(item),
    }),
    [agents, offers, onOpenAgentSettings, onRecheckOffers],
  );
  const findItem = useMemo(
    () =>
      items
        ? (selection: { itemId: string }) =>
            items.find((item) => agentActorItemId(item) === selection.itemId)
        : null,
    [items],
  );
  const detail = useCollectionDetailItemBinding({
    controller: detailController,
    createContent: createReadOnlyDetail,
    findItem,
  });

  useEffect(() => {
    if (!editSession || !detailController) return;
    const selection = detailSelection(instanceKey, editSession.item);
    const session = editSession;
    const accessBlocked =
      Boolean(accessRecovery?.open) &&
      accessRecovery?.pending?.placement === "inline" &&
      accessRecovery.pending?.intentKey === "agent-actor-update-apply";
    void detailController
      .open({
        canClose: async () => {
          if (accessBlocked) {
            accessRecovery?.close();
            return false;
          }
          // The Tauri dialog plugin makes window.confirm resolve asynchronously.
          if (
            editSession.guard.dirty &&
            !(await window.confirm(m.agent_actors_discard_confirm()))
          ) {
            return false;
          }
          editSession.guard.dirty = false;
          setEditSession((current) =>
            current === editSession ? null : current,
          );
          return true;
        },
        content: (
          <div className="flex min-w-0 flex-col gap-4">
            <AgentActorDetail
              agents={agents}
              draft={editSession.draft}
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
                void applyMutation("update", editSession.item.ownerPath, draft);
              }}
            />
            {accessBlocked ? (
              <RepositoryAccessInlineRecovery recovery={accessRecovery!} />
            ) : null}
          </div>
        ),
        description: (
          <span className="sr-only">{m.agent_actors_edit_description()}</span>
        ),
        footerActions: (
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
                editSession.guard.dirty = false;
                setEditSession(null);
                void detail.open(editSession.item, selection);
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
                form={`agent-actor-detail-${editSession.draft.id}`}
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
        layout: "form",
        selection,
        title: detailTitle(editSession.item),
      })
      .then((opened) => {
        if (!opened) {
          setEditSession((current) => (current === session ? null : current));
        }
      });
  }, [
    accessRecovery,
    agents,
    applyMutation,
    detail,
    detailController,
    editSession,
    instanceKey,
    mutationPending,
    offers,
    onOpenAgentSettings,
    onRecheckOffers,
    readOnly,
    setEditSession,
  ]);

  return detail;
}

function detailSelection(instanceKey: string, item: AgentActorItem) {
  return {
    instanceKey,
    presentationId: "agents",
    itemId: agentActorItemId(item),
  };
}

function detailTitle(item: AgentActorItem) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <AgentAvatar shape="square" size="lg" />
      <span className="flex min-w-0 flex-col text-left">
        <span className="truncate">{item.name}</span>
        {item.description ? (
          <span className="truncate text-sm font-normal text-muted-foreground">
            {item.description}
          </span>
        ) : null}
        <span className="truncate text-sm font-normal text-muted-foreground">
          {m.agent_actors_owner({ owner: item.ownerLabel })}
        </span>
      </span>
    </span>
  );
}
