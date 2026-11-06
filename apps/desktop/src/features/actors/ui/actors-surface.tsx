import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAgentAdapterDictionary } from "@/features/agent-adapters";
import {
  CollectionHost,
  useCollectionState,
  type CollectionActionState,
  type CollectionInstance,
  type CollectionPresentationState,
} from "@/features/collection";
import {
  COLLECTION_ITEM_UNREAD,
  CollectionItemMain,
  CollectionItemPeek,
  useCollectionItemPeek,
} from "@/features/collection/app-shell";
import {
  RepositoryAccessPreflightDialog,
  useRepositoryAccessPreflight,
  type RepositoryAccessRequest,
  type RepositoryAccessTarget,
} from "@/features/git";
import { useSignalUserEdit } from "@/features/navigation";
import type { ScopeSurfaceRenderContext } from "@/features/scope-surfaces";
import * as m from "@/paraglide/messages.js";

import { useActorCatalog } from "../hooks/use-actor-catalog";
import { useActorPeek } from "../hooks/use-actor-peek";
import { useActorMailmapSave } from "../hooks/use-actor-mailmap-save";
import { useActorMutation } from "../hooks/use-actor-mutation";
import { useAgentActorsController } from "../hooks/use-agent-actors-controller";
import { actorPeekIdentity, type ActorPeekTarget } from "../model/actor-peek";
import type { AgentActorItem } from "../model/agent-actor-types";
import {
  isAgentActorCatalogReadComplete,
  isPersonCatalogReadComplete,
} from "../model/catalog-completeness";
import type { ActorCatalogState } from "../model/catalog-state";
import type {
  ActorMutationIntent,
  AppliedActorMutationResult,
} from "../model/identity-mutation";
import type { ActorCatalogItem } from "../model/types";
import { ActorMailmapSaveDialog } from "./actor-mailmap-save-dialog";
import { ActorMutationDialog } from "./actor-mutation-dialog";
import { showActorMutationOutcome } from "./actor-mutation-outcome";
import {
  actorCatalogBlockingError,
  createActorsPresentation,
} from "./actors-presentation";
import {
  agentActorItemId,
  createAgentActorsPresentation,
} from "./agent-actors-presentation";
import { CatalogRetryButton } from "./catalog-retry-button";

export function ActorsSurface({
  owner,
  openItem,
  mainItem,
  onExpandItem,
  readOnly = false,
  repositoryOwnerName,
  onOpenAgentSettings,
  onOpenRepositorySettings,
}: ScopeSurfaceRenderContext & {
  readOnly?: boolean;
  repositoryOwnerName?: string;
  /** Opens the agent settings, as "Configure agents…" of a binding. */
  onOpenAgentSettings(): void;
  onOpenRepositorySettings?: (repositoryPath: string) => void;
}) {
  const { refresh, replaceSnapshot, state } = useActorCatalog(owner.spacePath);
  const accessRecovery = useRepositoryAccessPreflight();
  const agents = useAgentAdapterDictionary();
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
  const peek = useCollectionItemPeek<ActorPeekTarget>(actorPeekIdentity);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [focusItemId, setFocusItemId] = useState<string | null>(null);
  const instanceKey = `actors:${owner.ownerKey}`;
  const { close: closePeek, open: openPeek } = peek;
  const agentActors = useAgentActorsController({
    owner,
    peek,
    readOnly,
    onOpenAgentSettings,
    onOpenRepositorySettings,
  });
  const catalogItems = useMemo(
    () => (state.phase === "ready" ? state.snapshot.items : []),
    [state],
  );
  const humanPeek = useActorPeek({
    snapshot: state.phase === "ready" ? state.snapshot : null,
    spacePath: owner.spacePath,
  });
  // A person the main area shows follows a new canonical email of its own:
  // Desktop moves its navigation keys, and the main area opens it again.
  const [followedEmail, setFollowedEmail] = useState<{
    from: string;
    to: string;
  } | null>(null);
  const signalUserEdit = useSignalUserEdit();
  const onApplied = useCallback(
    (result: AppliedActorMutationResult, source: string | null) => {
      const shown =
        mainItem?.item.presentationId === "humans"
          ? mainItem.item.itemId
          : null;
      if (shown !== null && source === shown) {
        signalUserEdit();
        if (result.canonicalEmail !== shown) {
          setFollowedEmail({ from: shown, to: result.canonicalEmail });
          onExpandItem?.({
            surfaceId: "actors",
            presentationId: "humans",
            itemId: result.canonicalEmail,
          });
        }
      }
      replaceSnapshot(result.catalog);
      setFocusItemId(result.canonicalEmail);
      // A merge or a new canonical email may leave the open person gone.
      void closePeek();
      showActorMutationOutcome(result);
    },
    [closePeek, mainItem, onExpandItem, replaceSnapshot, signalUserEdit],
  );
  const onDuplicate = useCallback(
    (canonicalEmail: string) => {
      const actor = catalogItems.find(
        (item) => item.canonicalEmail === canonicalEmail,
      );
      setFocusItemId(canonicalEmail);
      if (!actor) return;
      openPeek({ presentationId: "humans", itemId: actor.canonicalEmail });
    },
    [catalogItems, openPeek],
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
    if (!focusItemId || state.phase !== "ready") return;
    if (
      !state.snapshot.items.some((item) => item.canonicalEmail === focusItemId)
    ) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const itemElement = Array.from(
        surfaceRef.current?.querySelectorAll<HTMLElement>(
          "[data-collection-row]",
        ) ?? [],
      ).find((element) => element.dataset.collectionRow === focusItemId);
      itemElement?.focus({ preventScroll: true });
      itemElement?.scrollIntoView?.({ block: "nearest" });
      setFocusItemId(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusItemId, state]);

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
        mutationState.status === "idle" && catalogItems.length < 2
          ? {
              reason: m.actors_mutation_disabled_merge_target(),
              status: "disabled",
            }
          : mutationState,
      onAdd: () => requestMutationIntent({ kind: "add" }),
      onEdit: (source) => requestMutationIntent({ kind: "edit", source }),
      onMerge: (source) => requestMutationIntent({ kind: "merge", source }),
    },
    onActivate: peek.activation((_item: ActorCatalogItem, context) => ({
      presentationId: "humans",
      itemId: context.itemId,
    })),
    state: presentationState,
  });
  const agentActorsPresentation = createAgentActorsPresentation({
    actions: agentActors.actions,
    agents,
    editing: agentActors.editing,
    facts: agentActors.facts,
    inheritedVisible: agentActors.inheritedVisible,
    onActivate: peek.activation((_item: AgentActorItem, context) => ({
      presentationId: "agents",
      itemId: context.itemId,
    })),
    spaceName: agentActors.spaceName,
    state: agentActors.presentationState,
  });
  const instance: CollectionInstance = {
    defaultPresentationId: "humans",
    instanceKey,
    presentations: [presentation, agentActorsPresentation],
    stateScope: "session",
  };
  const collectionState = useCollectionState(instance);
  // An Agent Actor addressed by the open request, such as the one of a
  // refused Routine launch, opens once its catalog is read.
  const agentActorItems =
    agentActors.presentationState.phase === "ready"
      ? agentActors.presentationState.items
      : null;
  const setActivePresentationId =
    collectionState.phase === "ready"
      ? collectionState.setActivePresentationId
      : null;
  const appliedOpenItem = useRef<typeof openItem>(undefined);
  useEffect(() => {
    if (!openItem || !agentActorItems || !setActivePresentationId) return;
    if (appliedOpenItem.current === openItem) return;
    appliedOpenItem.current = openItem;
    openItem.consume();
    const item = agentActorItems.find(
      (candidate) => candidate.id === openItem.id,
    );
    if (!item) return;
    setActivePresentationId("agents");
    openPeek({ presentationId: "agents", itemId: agentActorItemId(item) });
  }, [agentActorItems, openItem, openPeek, setActivePresentationId]);

  const dialogs = (
    <>
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
        items={catalogItems}
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
    </>
  );
  const expand = (target: ActorPeekTarget) => {
    if (!onExpandItem) return null;
    if (target.presentationId === "humans") {
      return () =>
        onExpandItem({
          surfaceId: "actors",
          presentationId: "humans",
          itemId: target.itemId,
        });
    }
    const agent = agentActorItems?.find(
      (candidate) => agentActorItemId(candidate) === target.itemId,
    );
    return agent
      ? () =>
          onExpandItem({
            surfaceId: "actors",
            presentationId: "agents",
            itemId: agent.id,
          })
      : null;
  };
  const renderItem = (
    item: ActorCatalogItem | AgentActorItem,
    target: ActorPeekTarget,
  ) =>
    target.presentationId === "humans"
      ? humanPeek.render(item as ActorCatalogItem, presentation)
      : agentActors.peek.render(
          item as AgentActorItem,
          agentActorsPresentation,
        );
  const mainTarget: ActorPeekTarget | null = mainItem
    ? {
        presentationId:
          mainItem.item.presentationId === "agents" ? "agents" : "humans",
        itemId:
          followedEmail?.from === mainItem.item.itemId
            ? followedEmail.to
            : mainItem.item.itemId,
      }
    : null;
  if (mainItem && mainTarget && collectionState.phase !== "blocking_error") {
    return (
      <div
        ref={surfaceRef}
        className="flex min-h-full flex-col"
        data-actors-surface
      >
        <CollectionItemMain<ActorPeekTarget, ActorCatalogItem | AgentActorItem>
          main={mainItem}
          target={mainTarget}
          find={(target) => {
            if (target.presentationId === "humans") {
              if (state.phase !== "ready") return null;
              return (
                humanPeek.find(target.itemId) ??
                (isPersonCatalogReadComplete(state.snapshot)
                  ? undefined
                  : COLLECTION_ITEM_UNREAD)
              );
            }
            const { snapshot } = agentActors;
            if (!agentActorItems || !snapshot) return null;
            const agent = agentActorItems.find(
              (candidate) => candidate.id === target.itemId,
            );
            if (agent) return agentActors.peek.find(agentActorItemId(agent));
            return isAgentActorCatalogReadComplete(snapshot)
              ? undefined
              : COLLECTION_ITEM_UNREAD;
          }}
          render={renderItem}
        />
        {dialogs}
      </div>
    );
  }

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
      <CollectionHost instance={instance} state={collectionState} />
    );

  return (
    <div
      ref={surfaceRef}
      className="flex min-h-0 flex-1 flex-col"
      data-actors-surface
    >
      {body}
      {dialogs}
      <CollectionItemPeek<ActorPeekTarget, ActorCatalogItem | AgentActorItem>
        peek={peek}
        find={(target) =>
          target.presentationId === "humans"
            ? humanPeek.find(target.itemId)
            : agentActors.peek.find(target.itemId)
        }
        render={renderItem}
        expand={expand}
      />
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
): CollectionActionState {
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
): CollectionPresentationState<ActorCatalogItem> {
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
    items: state.snapshot.items,
  };
}
