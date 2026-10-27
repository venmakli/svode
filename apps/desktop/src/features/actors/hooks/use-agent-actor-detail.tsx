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
  useCollectionDetailRowBinding,
  type CollectionDetailContent,
  type CollectionDetailController,
  type CollectionDetailRowBinding,
} from "@/features/collection/app-shell";
import {
  RepositoryAccessInlineRecovery,
  RepositoryAccessPrimaryButton,
  type RepositoryAccessPreflightController,
} from "@/features/git";
import { AgentAvatar } from "@/features/identity";
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
  readOnly = false,
  pendingAdapter,
  rows,
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
  detailController: CollectionDetailController | null;
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
  readOnly?: boolean;
  pendingAdapter: AgentActorBinding["adapter"] | null;
  /** The agents of the ready catalog; null until it is read. */
  rows: readonly AgentActorRow[] | null;
  savedRuntimeFor(
    row: AgentActorRow,
  ): Partial<Record<AgentActorBinding["adapter"], AgentActorBindingRuntime>>;
  setEditSession: Dispatch<SetStateAction<AgentActorEditSession | null>>;
}): CollectionDetailRowBinding<AgentActorRow> {
  const createReadOnlyDetail = useCallback(
    (row: AgentActorRow): CollectionDetailContent => ({
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
    }),
    [descriptors, diagnose, diagnostics, pendingAdapter, savedRuntimeFor],
  );
  const findRow = useMemo(
    () =>
      rows
        ? (selection: { rowId: string }) =>
            rows.find((row) => agentActorRowId(row) === selection.rowId)
        : null,
    [rows],
  );
  const detail = useCollectionDetailRowBinding({
    controller: detailController,
    createContent: createReadOnlyDetail,
    findRow,
  });

  useEffect(() => {
    if (!editSession || !detailController) return;
    const selection = detailSelection(instanceKey, editSession.row);
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
              descriptors={descriptors}
              diagnostics={diagnostics}
              draft={editSession.draft}
              editMode={!readOnly}
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
              onSave={() => {
                if (readOnly) return;
                void applyMutation(
                  "update",
                  editSession.row.ownerPath,
                  editSession.draft,
                );
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
                void detail.open(editSession.row, selection);
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
    descriptors,
    detail,
    detailController,
    diagnose,
    diagnostics,
    editRuntime,
    editSession,
    instanceKey,
    mutationPending,
    pendingAdapter,
    readOnly,
    setEditSession,
  ]);

  return detail;
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
      <AgentAvatar shape="square" size="lg" />
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
