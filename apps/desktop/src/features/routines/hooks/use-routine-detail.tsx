import { useCallback, useEffect } from "react";
import { AlertTriangle, LoaderCircle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { AgentActorOption } from "@/features/actors";
import type {
  CollectionDetailController,
  CollectionDetailRequest,
} from "@/features/collection/app-shell";
import type { CollectionActionState } from "@/features/collection";
import * as m from "@/paraglide/messages.js";

import type { RoutineOwnerInput } from "../api/routines-api";
import type { RoutineDefinition, RoutineRow } from "../model/types";
import { RoutineDefinitionForm } from "../ui/routine-definition-form";
import { RoutineDetailView } from "../ui/routine-detail-view";
import { RoutineDetailActions } from "../ui/routine-detail-actions";
import { routineDetailTitle } from "../ui/routines-presentation";
import type { RoutineEditSession } from "./use-routine-mutations";

export function useRoutineDetail({
  applyUpdate,
  detailController,
  editSession,
  executorError,
  executors,
  instanceKey,
  mutationError,
  nameError,
  getRunState,
  onOpenSession,
  onRun,
  owner,
  pending,
  readOnly,
  onEditChange,
  setEditSession,
}: {
  applyUpdate(
    row: RoutineRow,
    definition: RoutineDefinition,
  ): Promise<RoutineRow | null>;
  detailController: CollectionDetailController | null;
  editSession: RoutineEditSession | null;
  executorError: string | null;
  executors: readonly AgentActorOption[];
  instanceKey: string;
  mutationError: string | null;
  nameError: string | null;
  getRunState(row: RoutineRow): CollectionActionState;
  onOpenSession(row: RoutineRow): void;
  onRun(row: RoutineRow): Promise<void>;
  owner: RoutineOwnerInput;
  pending: boolean;
  readOnly: boolean;
  onEditChange(definition: RoutineDefinition): void;
  setEditSession(
    value:
      | RoutineEditSession
      | null
      | ((current: RoutineEditSession | null) => RoutineEditSession | null),
  ): void;
}) {
  const createReadOnlyDetail = useCallback(
    (row: RoutineRow): Omit<CollectionDetailRequest, "selection"> => ({
      content: <RoutineDetailView row={row} />,
      description: (
        <span className="sr-only">{m.routines_detail_description()}</span>
      ),
      footerActions: (
        <RoutineDetailActions
          row={row}
          runState={getRunState(row)}
          onOpenSession={onOpenSession}
          onRun={onRun}
        />
      ),
      title: routineDetailTitle(row),
    }),
    [getRunState, onOpenSession, onRun],
  );

  useEffect(() => {
    if (!editSession || !detailController) return;
    const session = editSession;
    const formId = `routine-detail-${session.row.id}`;
    const selection = {
      instanceKey,
      presentationId: "all",
      rowId: session.row.id,
    };
    void detailController
      .open({
        canClose: () => {
          if (
            session.guard.dirty &&
            !window.confirm(m.routines_discard_confirm())
          ) {
            return false;
          }
          session.guard.dirty = false;
          setEditSession((current) => (current === session ? null : current));
          return true;
        },
        content: (
          <div className="flex flex-col gap-4">
            {mutationError ? (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertDescription>{mutationError}</AlertDescription>
              </Alert>
            ) : null}
            <fieldset disabled={readOnly} className="contents">
              <RoutineDefinitionForm
                collectionOwner={owner.ownerKind === "collection_directory"}
                definition={session.draft}
                executorError={executorError}
                executors={executors}
                formId={formId}
                nameError={nameError}
                onChange={onEditChange}
                onSubmit={() => {
                  if (readOnly) return;
                  void (async () => {
                    const updated = await applyUpdate(
                      session.row,
                      session.draft,
                    );
                    if (!updated) return;
                    session.guard.dirty = false;
                    setEditSession(null);
                    await detailController.open({
                      ...createReadOnlyDetail(updated),
                      selection,
                    });
                  })();
                }}
              />
            </fieldset>
          </div>
        ),
        description: (
          <span className="sr-only">{m.routines_edit_description()}</span>
        ),
        footerActions: (
          <div className="flex w-full justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                session.guard.dirty = false;
                setEditSession(null);
                void detailController.open({
                  ...createReadOnlyDetail(session.row),
                  selection,
                });
              }}
            >
              {m.routines_cancel()}
            </Button>
            <Button type="submit" form={formId} disabled={pending || readOnly}>
              {pending ? (
                <LoaderCircle
                  data-icon="inline-start"
                  className="animate-spin"
                />
              ) : null}
              {pending ? m.routines_saving() : m.routines_save()}
            </Button>
          </div>
        ),
        selection,
        title: routineDetailTitle({
          ...session.row,
          description: session.draft.description,
          name: session.draft.name,
        }),
      })
      .then((opened) => {
        if (!opened) {
          setEditSession((current) => (current === session ? null : current));
        }
      });
  }, [
    applyUpdate,
    createReadOnlyDetail,
    detailController,
    editSession,
    executorError,
    executors,
    instanceKey,
    mutationError,
    nameError,
    getRunState,
    onOpenSession,
    onRun,
    owner.ownerKind,
    pending,
    readOnly,
    onEditChange,
    setEditSession,
  ]);

  return createReadOnlyDetail;
}
