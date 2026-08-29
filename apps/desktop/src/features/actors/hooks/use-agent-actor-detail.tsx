import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Bot, LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  SystemCollectionDetailController,
  SystemCollectionDetailRequest,
} from "@/features/collection/system";
import {
  RepositoryAccessInlineRecovery,
  RepositoryAccessPrimaryButton,
  type RepositoryAccessPreflightController,
} from "@/features/git";
import * as m from "@/paraglide/messages.js";

import { createAgentActorDraft } from "../model/agent-actor-draft";
import type {
  AgentActorAdapterDescriptor,
  AgentActorAdapterDiagnostic,
  AgentActorBinding,
  AgentActorBindingRuntime,
  AgentActorDraft,
  AgentActorRow,
} from "../model/agent-actor-types";
import { AgentActorDetail } from "../ui/agent-actor-detail";
import { agentActorRowId } from "../ui/agent-actors-presentation";
import type { AgentActorEditSession } from "./use-agent-actor-mutations";

export function useAgentActorDetail({
  accessRecovery,
  applyMutation,
  descriptors,
  detailController,
  diagnose,
  diagnostics,
  editRuntime,
  editSession,
  instanceKey,
  mutationPending,
  pendingAdapter,
  savedRuntimeFor,
  setEditSession,
}: {
  accessRecovery?: RepositoryAccessPreflightController;
  applyMutation(
    kind: "update",
    ownerPath: string,
    draft: AgentActorDraft,
  ): void | Promise<void>;
  descriptors: readonly AgentActorAdapterDescriptor[];
  detailController: SystemCollectionDetailController | null;
  diagnose(adapter: AgentActorBinding["adapter"]): void;
  diagnostics: Readonly<
    Partial<Record<AgentActorBinding["adapter"], AgentActorAdapterDiagnostic>>
  >;
  editRuntime: Partial<
    Record<AgentActorBinding["adapter"], AgentActorBindingRuntime>
  >;
  editSession: AgentActorEditSession | null;
  instanceKey: string;
  mutationPending: boolean;
  pendingAdapter: AgentActorBinding["adapter"] | null;
  savedRuntimeFor(
    row: AgentActorRow,
  ): Partial<Record<AgentActorBinding["adapter"], AgentActorBindingRuntime>>;
  setEditSession: Dispatch<SetStateAction<AgentActorEditSession | null>>;
}) {
  const readOnlyRowRef = useRef<AgentActorRow | null>(null);
  const createReadOnlyDetail = useCallback(
    (row: AgentActorRow): Omit<SystemCollectionDetailRequest, "selection"> => {
      readOnlyRowRef.current = row;
      return {
        canClose: () => {
          if (readOnlyRowRef.current === row) readOnlyRowRef.current = null;
          return true;
        },
        content: (
          <AgentActorDetail
            descriptors={descriptors}
            diagnostics={diagnostics}
            draft={createAgentActorDraft(row.ownerPath, row)}
            editMode={false}
            pendingAdapter={pendingAdapter}
            runtime={savedRuntimeFor(row)}
            onChange={() => undefined}
            onCheck={diagnose}
            onSave={() => undefined}
          />
        ),
        description: (
          <span className="sr-only">{m.agent_actors_detail_description()}</span>
        ),
        title: detailTitle(row),
      };
    },
    [descriptors, diagnose, diagnostics, pendingAdapter, savedRuntimeFor],
  );

  useEffect(() => {
    const row = readOnlyRowRef.current;
    if (!row || editSession || !detailController) return;
    void detailController.open({
      ...createReadOnlyDetail(row),
      selection: detailSelection(instanceKey, row),
    });
  }, [createReadOnlyDetail, detailController, editSession, instanceKey]);

  useEffect(() => {
    if (!editSession || !detailController) return;
    readOnlyRowRef.current = null;
    const selection = detailSelection(instanceKey, editSession.row);
    const session = editSession;
    const accessBlocked =
      Boolean(accessRecovery?.open) &&
      accessRecovery?.pending?.placement === "inline" &&
      accessRecovery.pending?.intentKey === "agent-actor-update-apply";
    void detailController
      .open({
        canClose: () => {
          if (accessBlocked) {
            accessRecovery?.close();
            return false;
          }
          if (
            editSession.guard.dirty &&
            !window.confirm(m.agent_actors_discard_confirm())
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
              descriptors={descriptors}
              diagnostics={diagnostics}
              draft={editSession.draft}
              editMode={true}
              pendingAdapter={pendingAdapter}
              runtime={editRuntime}
              onChange={(draft) =>
                setEditSession((current) => {
                  if (!current) return current;
                  current.guard.dirty = true;
                  return { ...current, draft };
                })
              }
              onCheck={diagnose}
              onSave={() =>
                void applyMutation(
                  "update",
                  editSession.row.ownerPath,
                  editSession.draft,
                )
              }
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
                void detailController.open({
                  ...createReadOnlyDetail(editSession.row),
                  selection,
                });
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
                disabled={mutationPending}
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
        selection,
        title: detailTitle(editSession.row),
      })
      .then((opened) => {
        if (!opened) {
          setEditSession((current) => (current === session ? null : current));
        }
      });
  }, [
    accessRecovery,
    applyMutation,
    createReadOnlyDetail,
    descriptors,
    detailController,
    diagnose,
    diagnostics,
    editRuntime,
    editSession,
    instanceKey,
    mutationPending,
    pendingAdapter,
    setEditSession,
  ]);

  return createReadOnlyDetail;
}

function detailSelection(instanceKey: string, row: AgentActorRow) {
  return {
    instanceKey,
    presentationId: "agents",
    rowId: agentActorRowId(row),
  };
}

function detailTitle(row: AgentActorRow) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <Bot className="size-6 text-muted-foreground" />
      <span className="flex min-w-0 flex-col text-left">
        <span className="truncate">{row.name}</span>
        {row.description ? (
          <span className="truncate text-sm font-normal text-muted-foreground">
            {row.description}
          </span>
        ) : null}
        <span className="truncate text-sm font-normal text-muted-foreground">
          {m.agent_actors_owner({ owner: row.ownerLabel })}
        </span>
      </span>
    </span>
  );
}
