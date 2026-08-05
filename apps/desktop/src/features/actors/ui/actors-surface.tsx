import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  SystemCollectionPresentationCore,
  useOptionalSystemCollectionDetailController,
  useSystemCollectionState,
  type SystemCollectionActionState,
  type SystemCollectionInstance,
  type SystemCollectionPresentationState,
} from "@/features/collection/system";
import { useRepositoryAccess } from "@/features/git";
import type { ScopeSurfaceRenderContext } from "@/features/scope-surfaces";
import * as m from "@/paraglide/messages.js";

import { useActorCatalog } from "../hooks/use-actor-catalog";
import { useActorAccessPreflight } from "../hooks/use-actor-access-preflight";
import { useActorMailmapSave } from "../hooks/use-actor-mailmap-save";
import { useActorMutation } from "../hooks/use-actor-mutation";
import { useAgentActorsController } from "../hooks/use-agent-actors-controller";
import type { ActorCatalogState } from "../model/catalog-state";
import type {
  ActorMutationIntent,
  AppliedActorMutationResult,
} from "../model/identity-mutation";
import type { ActorCatalogRow } from "../model/types";
import { ActorAccessPreflightDialog } from "./actor-access-preflight-dialog";
import { ActorMailmapSaveDialog } from "./actor-mailmap-save-dialog";
import { ActorMutationDialog } from "./actor-mutation-dialog";
import { showActorMutationOutcome } from "./actor-mutation-outcome";
import {
  actorCatalogBlockingError,
  createActorDetailRequest,
  createActorsPresentation,
} from "./actors-presentation";
import { createAgentActorsPresentation } from "./agent-actors-presentation";

export function ActorsSurface({ owner }: ScopeSurfaceRenderContext) {
  const { refresh, replaceSnapshot, state } = useActorCatalog(owner.spacePath);
  const access = useRepositoryAccess(owner.spacePath);
  const detailController = useOptionalSystemCollectionDetailController();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [focusRowId, setFocusRowId] = useState<string | null>(null);
  const instanceKey = `actors:${owner.ownerKey}`;
  const agentActors = useAgentActorsController({
    detailController,
    instanceKey,
    owner,
  });
  const catalogRows = useMemo(
    () => (state.phase === "ready" ? state.snapshot.rows : []),
    [state],
  );
  const catalogGeneration =
    state.phase === "ready" ? state.snapshot.generation : 0;
  const onApplied = useCallback(
    (result: AppliedActorMutationResult) => {
      replaceSnapshot(result.catalog);
      setFocusRowId(result.canonicalEmail);
      void detailController?.close();
      showActorMutationOutcome(result);
    },
    [detailController, replaceSnapshot],
  );
  const onDuplicate = useCallback(
    (canonicalEmail: string) => {
      const actor = catalogRows.find(
        (row) => row.canonicalEmail === canonicalEmail,
      );
      setFocusRowId(canonicalEmail);
      if (!actor || !detailController) return;
      void detailController.open({
        ...createActorDetailRequest(actor, owner.spacePath, catalogGeneration),
        selection: {
          instanceKey,
          presentationId: "humans",
          rowId: actor.canonicalEmail,
        },
      });
    },
    [
      catalogGeneration,
      catalogRows,
      detailController,
      instanceKey,
      owner.spacePath,
    ],
  );
  const mutation = useActorMutation({
    onApplied,
    onDuplicate,
    projectPath: owner.projectPath,
    spacePath: owner.spacePath,
  });
  const mailmapSave = useActorMailmapSave({
    projectPath: owner.projectPath,
    spacePath: owner.spacePath,
  });
  const { openAdd, openEdit, openMerge } = mutation;
  const continueMutationIntent = useCallback(
    (intent: ActorMutationIntent) => {
      if (intent.kind === "add") openAdd();
      else if (intent.kind === "merge") openMerge(intent.source);
      else openEdit(intent.source);
    },
    [openAdd, openEdit, openMerge],
  );
  const accessPreflight = useActorAccessPreflight({
    error: access.error,
    snapshot: access.snapshot,
    verifying: access.verifying,
    onContinue: continueMutationIntent,
    onVerify: access.verify,
  });

  useEffect(() => {
    if (!focusRowId || state.phase !== "ready") return;
    if (!state.snapshot.rows.some((row) => row.canonicalEmail === focusRowId)) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const row = Array.from(
        surfaceRef.current?.querySelectorAll<HTMLElement>(
          "[data-system-collection-row]",
        ) ?? [],
      ).find((element) => element.dataset.systemCollectionRow === focusRowId);
      row?.focus({ preventScroll: true });
      row?.scrollIntoView?.({ block: "nearest" });
      setFocusRowId(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRowId, state]);

  const presentationState = toPresentationState(state);
  const mutationState = mutationActionState(
    state,
    mutation.pendingPhase !== null,
  );
  const presentation = createActorsPresentation({
    catalogGeneration,
    mutations: {
      createState: mutationState,
      getEditState: () => mutationState,
      getMergeState: () =>
        mutationState.status === "idle" && catalogRows.length < 2
          ? {
              reason: m.actors_mutation_disabled_merge_target(),
              status: "disabled",
            }
          : mutationState,
      onAdd: () => accessPreflight.request({ kind: "add" }),
      onEdit: (source) => accessPreflight.request({ kind: "edit", source }),
      onMerge: (source) => accessPreflight.request({ kind: "merge", source }),
    },
    onRefresh: refresh,
    refreshing: state.phase === "ready" && state.refreshing,
    spacePath: owner.spacePath,
    state: presentationState,
  });
  const agentActorsPresentation = createAgentActorsPresentation({
    actions: agentActors.actions,
    inheritedVisible: agentActors.inheritedVisible,
    onRefresh: agentActors.onRefresh,
    refreshing: agentActors.refreshing,
    renderDetail: agentActors.renderDetail,
    state: agentActors.presentationState,
  });
  const instance: SystemCollectionInstance = {
    defaultPresentationId: "humans",
    instanceKey,
    presentations: [presentation, agentActorsPresentation],
    stateScope: "session",
  };
  const collectionState = useSystemCollectionState(instance);

  const body =
    collectionState.phase === "blocking_error" ? (
      <div className="px-6 py-3">
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription className="flex flex-col gap-1">
            {collectionState.diagnostics.map((diagnostic) => (
              <span key={diagnostic}>{diagnostic}</span>
            ))}
          </AlertDescription>
        </Alert>
      </div>
    ) : (
      <SystemCollectionPresentationCore
        detailController={detailController ?? undefined}
        instance={instance}
        state={collectionState}
      />
    );

  return (
    <div
      ref={surfaceRef}
      className="flex min-h-0 flex-1 flex-col"
      data-actors-surface
    >
      {body}
      <ActorAccessPreflightDialog
        error={access.error}
        intent={accessPreflight.intent}
        snapshot={access.snapshot}
        verifying={access.verifying}
        onClose={accessPreflight.close}
        onVerify={accessPreflight.verify}
      />
      <ActorMutationDialog
        key={mutation.sessionId}
        commitExpectation={mutation.commitExpectation}
        duplicateEmail={mutation.duplicateEmail}
        failure={mutation.failure}
        intent={mutation.intent}
        pendingPhase={mutation.pendingPhase}
        review={mutation.review}
        rootPointerCommitExpectation={mutation.rootPointerCommitExpectation}
        rows={catalogRows}
        onApply={() => void mutation.apply()}
        onBack={mutation.back}
        onClose={mutation.close}
        onOpenDuplicate={mutation.openDuplicate}
        onRequestPreview={(action) => void mutation.requestPreview(action)}
        onRetryReview={mutation.retryReview}
      />
      <ActorMailmapSaveDialog
        failure={mailmapSave.failure}
        pending={mailmapSave.pendingPhase === "commit"}
        review={mailmapSave.review}
        onClose={mailmapSave.close}
        onConfirm={() => void mailmapSave.confirm()}
      />
      {agentActors.overlays}
    </div>
  );
}

function mutationActionState(
  catalog: ActorCatalogState,
  mutationPending: boolean,
): SystemCollectionActionState {
  if (mutationPending) return { status: "pending" };
  if (catalog.phase === "initial") {
    return {
      reason: m.actors_mutation_disabled_loading(),
      status: "disabled",
    };
  }
  if (catalog.phase === "blocking_error") {
    return {
      reason: m.actors_mutation_disabled_unavailable(),
      status: "disabled",
    };
  }
  if (catalog.snapshot.diagnostics.some((diagnostic) => diagnostic.blocking)) {
    return {
      reason: m.actors_mutation_disabled_mailmap(),
      status: "disabled",
    };
  }
  return { status: "idle" };
}

function toPresentationState(
  state: ReturnType<typeof useActorCatalog>["state"],
): SystemCollectionPresentationState<ActorCatalogRow> {
  if (state.phase === "initial") return { phase: "initial" };
  if (state.phase === "blocking_error") {
    return {
      error: actorCatalogBlockingError(
        m.actors_catalog_error_title(),
        state.error,
      ),
      phase: "blocking_error",
    };
  }

  const diagnostics = state.snapshot.diagnostics.map((diagnostic) => (
    <span
      key={`${diagnostic.kind}:${diagnostic.line ?? ""}:${diagnostic.message}`}
    >
      {diagnostic.message}
    </span>
  ));
  if (state.snapshot.shallow) {
    diagnostics.push(<span key="shallow">{m.actors_shallow_history()}</span>);
  }
  if (state.refreshError) {
    diagnostics.push(
      <span key="refresh" title={state.refreshError}>
        {m.actors_refresh_error()}
      </span>,
    );
  }

  return {
    diagnostics,
    phase: "ready",
    refreshing: state.refreshing,
    rows: state.snapshot.rows,
  };
}
