import { useEffect, useMemo, useState } from "react";
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

import { useAgentContextInstructions } from "../hooks/use-agent-context-instructions";
import type { AgentContextCatalogState } from "../model/catalog-state";
import type { AgentContextInstructionRow } from "../model/types";
import {
  AgentContextInstructionsEmpty,
  createAgentContextInstructionsPresentation,
} from "./instructions-presentation";

export function AgentContextSurface({ owner }: ScopeSurfaceRenderContext) {
  const { refresh, state } = useAgentContextInstructions({
    ownerKey: owner.ownerKey,
    projectPath: owner.projectPath,
    spacePath: owner.spacePath,
  });
  const detailController = useOptionalSystemCollectionDetailController();
  const [openedRowId, setOpenedRowId] = useState<string | null>(null);
  const instanceKey = `agent-context:${owner.ownerKey}`;
  const refreshing = state.phase === "ready" && state.refreshing;
  const presentationState = toPresentationState(state);
  const presentation = useMemo(
    () =>
      createAgentContextInstructionsPresentation({
        onDetailRequested: setOpenedRowId,
        onRefresh: refresh,
        refreshing,
        state: presentationState,
      }),
    [presentationState, refresh, refreshing],
  );
  const instance = useMemo<SystemCollectionInstance>(
    () => ({
      defaultPresentationId: "instructions",
      instanceKey,
      presentations: [presentation],
      stateScope: "session",
    }),
    [instanceKey, presentation],
  );
  const collectionState = useSystemCollectionState(instance);

  useEffect(() => {
    if (!openedRowId || state.phase !== "ready" || !detailController) return;
    if (state.snapshot.rows.some((row) => row.id === openedRowId)) return;

    void detailController.close({
      instanceKey,
      presentationId: "instructions",
      rowId: openedRowId,
    });
  }, [detailController, instanceKey, openedRowId, state]);

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
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-agent-context-surface={owner.ownerKey}
    >
      <SystemCollectionPresentationCore
        detailController={detailController ?? undefined}
        instance={instance}
        state={collectionState}
      />
    </div>
  );
}

function toPresentationState(
  state: AgentContextCatalogState,
): SystemCollectionPresentationState<AgentContextInstructionRow> {
  if (state.phase === "initial") return { phase: "initial" };
  if (state.phase === "blocking_error") {
    return {
      error: (
        <span className="flex flex-col gap-1">
          <strong>{m.agent_context_blocking_title()}</strong>
          <span>{state.error}</span>
        </span>
      ),
      phase: "blocking_error",
    };
  }

  const diagnostics = state.snapshot.diagnostics.map((diagnostic, index) => (
    <span key={`${diagnostic}:${index}`}>{diagnostic}</span>
  ));
  if (state.refreshError) {
    diagnostics.push(
      <span key="refresh" title={state.refreshError}>
        {m.agent_context_refresh_error()}
      </span>,
    );
  }

  return {
    attention: <span>{m.agent_context_projection_attention()}</span>,
    diagnostics,
    phase: "ready",
    refreshing: state.refreshing,
    rows: state.snapshot.rows,
    sourceEmpty: <AgentContextInstructionsEmpty />,
  };
}
