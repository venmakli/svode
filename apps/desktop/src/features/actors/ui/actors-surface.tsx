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
import type { ActorCatalogRow } from "../model/types";
import {
  actorCatalogBlockingError,
  createActorsPresentation,
} from "./actors-presentation";

export function ActorsSurface({ owner }: ScopeSurfaceRenderContext) {
  const { refresh, state } = useActorCatalog(owner.spacePath);
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

  if (collectionState.phase === "blocking_error") {
    return (
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
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-actors-surface>
      <SystemCollectionPresentationCore
        detailController={detailController ?? undefined}
        instance={instance}
        state={collectionState}
      />
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
