import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  CollectionCorePresentationCore,
  useCollectionCoreState,
  type CollectionCoreActionState,
  type CollectionCoreInstance,
  type CollectionCorePresentationState,
} from "@/features/collection/core";
import {
  createCollectionDetailActivation,
  useOptionalCollectionDetailController,
} from "@/features/collection/app-shell";
import {
  RepositoryAccessPreflightDialog,
  useRepositoryAccessPreflight,
  type RepositoryAccessRequest,
  type RepositoryAccessTarget,
} from "@/features/git";
import type { ScopeSurfaceRenderContext } from "@/features/scope-surfaces";
import * as m from "@/paraglide/messages.js";

import { useActorCatalog } from "../hooks/use-actor-catalog";
import { useActorMailmapSave } from "../hooks/use-actor-mailmap-save";
import { useActorMutation } from "../hooks/use-actor-mutation";
import { useAgentActorsController } from "../hooks/use-agent-actors-controller";
import type { ActorCatalogState } from "../model/catalog-state";
import type {
  ActorMutationIntent,
  AppliedActorMutationResult,
} from "../model/identity-mutation";
import type { ActorCatalogRow } from "../model/types";
import { ActorMailmapSaveDialog } from "./actor-mailmap-save-dialog";
import { ActorMutationDialog } from "./actor-mutation-dialog";
import { showActorMutationOutcome } from "./actor-mutation-outcome";
import {
  actorCatalogBlockingError,
  createActorDetailRequest,
  createActorsPresentation,
} from "./actors-presentation";
import { createAgentActorsPresentation } from "./agent-actors-presentation";
import { CatalogRetryButton } from "./catalog-retry-button";

export function ActorsSurface({
  owner,
  readOnly = false,
  repositoryOwnerName,
  onOpenRepositorySettings,
}: ScopeSurfaceRenderContext & {
  readOnly?: boolean;
  repositoryOwnerName?: string;
  onOpenRepositorySettings?: (repositoryPath: string) => void;
}) {
  const { refresh, replaceSnapshot, state } = useActorCatalog(owner.spacePath);
  const accessRecovery = useRepositoryAccessPreflight();
  const repositoryTarget = useMemo<RepositoryAccessTarget>(
    () => ({
      displayName:
        repositoryOwnerName ?? repositoryNameFromPath(owner.spacePath),
      displayPath: owner.spacePath,
      repositoryPath: owner.spacePath,
      openSettings: onOpenRepositorySettings
        ? () => onOpenRepositorySettings(owner.spacePath)
        : undefined,
    }),
    [onOpenRepositorySettings, owner.spacePath, repositoryOwnerName],
  );
  const detailController = useOptionalCollectionDetailController();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [focusRowId, setFocusRowId] = useState<string | null>(null);
  const instanceKey = `actors:${owner.ownerKey}`;
  const agentActors = useAgentActorsController({
    detailController,
    instanceKey,
    owner,
    readOnly,
    onOpenRepositorySettings,
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
    onAccessBlocked: (continueIntent) =>
      accessRecovery.request(lateMutationRecoveryRequest(continueIntent)),
    onAccessDenied: (error, continueIntent) =>
      accessRecovery.recoverFromError(
        error,
        lateMutationRecoveryRequest(continueIntent),
      ),
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
  function lateMutationRecoveryRequest(
    continueIntent: () => void | Promise<void>,
  ): RepositoryAccessRequest {
    return {
      continuation: "explicit",
      continue: continueIntent,
      intentKey: "human-actor-apply",
      intentLabel: m.actors_mutation_confirm(),
      onPlanChanged: continueIntent,
      placement: "inline",
      targets: [repositoryTarget],
    };
  }
  const continueMutationIntent = useCallback(
    (intent: ActorMutationIntent) => {
      if (intent.kind === "add") openAdd();
      else if (intent.kind === "merge") openMerge(intent.source);
      else openEdit(intent.source);
    },
    [openAdd, openEdit, openMerge],
  );
  const requestMutationIntent = useCallback(
    (intent: ActorMutationIntent) => {
      if (readOnly) return;
      void accessRecovery.request({
        continuation: "automatic",
        continue: () => continueMutationIntent(intent),
        intentKey: `human-actor-${intent.kind}`,
        intentLabel: actorIntentLabel(intent),
        placement: "dialog",
        targets: [repositoryTarget],
      });
    },
    [accessRecovery, continueMutationIntent, readOnly, repositoryTarget],
  );

  useEffect(() => {
    if (!focusRowId || state.phase !== "ready") return;
    if (!state.snapshot.rows.some((row) => row.canonicalEmail === focusRowId)) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const row = Array.from(
        surfaceRef.current?.querySelectorAll<HTMLElement>(
          "[data-collection-core-row]",
        ) ?? [],
      ).find((element) => element.dataset.collectionCoreRow === focusRowId);
      row?.focus({ preventScroll: true });
      row?.scrollIntoView?.({ block: "nearest" });
      setFocusRowId(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRowId, state]);

  const presentationState = toPresentationState(state, () => void refresh());
  const mutationState = mutationActionState(
    state,
    mutation.pendingPhase !== null,
    readOnly,
  );
  const presentation = createActorsPresentation({
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
      onAdd: () => requestMutationIntent({ kind: "add" }),
      onEdit: (source) => requestMutationIntent({ kind: "edit", source }),
      onMerge: (source) => requestMutationIntent({ kind: "merge", source }),
    },
    onActivate: createCollectionDetailActivation({
      controller: detailController,
      createContent: (row) =>
        createActorDetailRequest(row, owner.spacePath, catalogGeneration),
      instanceKey,
      presentationId: "humans",
    }),
    state: presentationState,
  });
  const agentActorsPresentation = createAgentActorsPresentation({
    actions: agentActors.actions,
    inheritedVisible: agentActors.inheritedVisible,
    onActivate: createCollectionDetailActivation({
      controller: detailController,
      createContent: agentActors.renderDetail,
      instanceKey,
      presentationId: "agents",
    }),
    state: agentActors.presentationState,
  });
  const instance: CollectionCoreInstance = {
    defaultPresentationId: "humans",
    instanceKey,
    presentations: [presentation, agentActorsPresentation],
    stateScope: "session",
  };
  const collectionState = useCollectionCoreState(instance);

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
      <CollectionCorePresentationCore
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
      <RepositoryAccessPreflightDialog recovery={accessRecovery} />
      <ActorMutationDialog
        accessRecovery={accessRecovery}
        key={mutation.sessionId}
        commitExpectation={mutation.commitExpectation}
        duplicateEmail={mutation.duplicateEmail}
        failure={mutation.failure}
        intent={mutation.intent}
        pendingPhase={mutation.pendingPhase}
        review={mutation.review}
        rootPointerCommitExpectation={mutation.rootPointerCommitExpectation}
        rows={catalogRows}
        readOnly={readOnly}
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
        readOnly={readOnly}
        onClose={mailmapSave.close}
        onConfirm={() => void mailmapSave.confirm()}
      />
      {agentActors.overlays}
    </div>
  );
}

function actorIntentLabel(intent: ActorMutationIntent) {
  if (intent.kind === "add") return m.actors_add();
  if (intent.kind === "merge") return m.actors_merge();
  return m.actors_edit();
}

function repositoryNameFromPath(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function mutationActionState(
  catalog: ActorCatalogState,
  mutationPending: boolean,
  readOnly: boolean,
): CollectionCoreActionState {
  if (mutationPending) return { status: "pending" };
  if (readOnly) {
    return {
      reason: m.repository_work_status_read_only(),
      status: "disabled",
    };
  }
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
  onRetry: () => void,
): CollectionCorePresentationState<ActorCatalogRow> {
  if (state.phase === "initial") return { phase: "initial" };
  if (state.phase === "blocking_error") {
    return {
      error: actorCatalogBlockingError(
        m.actors_catalog_error_title(),
        state.error,
        {
          disabled: state.retrying,
          label: m.actors_retry(),
          onRetry,
        },
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
      <span key="refresh" className="flex flex-col items-start gap-2">
        <span title={state.refreshError}>{m.actors_refresh_error()}</span>
        <CatalogRetryButton
          disabled={state.refreshing}
          label={m.actors_retry()}
          onRetry={onRetry}
        />
      </span>,
    );
  }

  return {
    diagnostics,
    phase: "ready",
    rows: state.snapshot.rows,
  };
}
