import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  SystemCollectionPresentationCore,
  useOptionalSystemCollectionDetailController,
  useSystemCollectionState,
  type SystemCollectionInstance,
  type SystemCollectionPresentationState,
} from "@/features/collection/system";
import type { ScopeSurfaceRenderContext } from "@/features/scope-surfaces";
import * as m from "@/paraglide/messages.js";

import { useActorCatalog } from "../hooks/use-actor-catalog";
import { useRepositoryAccess } from "../hooks/use-repository-access";
import type { ActorCatalogRow } from "../model/types";
import {
  actorCatalogBlockingError,
  createActorsPresentation,
} from "./actors-presentation";
import { RepositoryAccessHeader } from "./repository-access-header";

export function ActorsSurface({ owner }: ScopeSurfaceRenderContext) {
  const { refresh, state } = useActorCatalog(owner.spacePath);
  const access = useRepositoryAccess(owner.spacePath);
  const presentationState = toPresentationState(state);
  const presentation = createActorsPresentation({
    onRefresh: refresh,
    refreshing: state.phase === "ready" && state.refreshing,
    spacePath: owner.spacePath,
    state: presentationState,
  });
  const instance: SystemCollectionInstance = {
    defaultPresentationId: "humans",
    instanceKey: `actors:${owner.ownerKey}`,
    presentations: [presentation],
    stateScope: "session",
  };
  const collectionState = useSystemCollectionState(instance);
  const detailController = useOptionalSystemCollectionDetailController();

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
    <div className="flex min-h-0 flex-1 flex-col" data-actors-surface>
      <RepositoryAccessHeader
        error={access.error}
        snapshot={access.snapshot}
        verifying={access.verifying}
        onVerify={() => void access.verify()}
      />
      {body}
    </div>
  );
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
