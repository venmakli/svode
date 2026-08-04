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
import {
  listAgentContextArtifactOpeners,
  openAgentContextArtifact,
  type ArtifactOpener,
} from "../api/agent-context-api";
import type { AgentContextCatalogState } from "../model/catalog-state";
import {
  AgentContextInstructionsEmpty,
  createAgentContextInstructionsPresentation,
} from "./instructions-presentation";
import {
  AgentContextSkillsEmpty,
  createAgentContextSkillsPresentation,
} from "./skills-presentation";

interface OpenedAgentContextRow {
  presentationId: "instructions" | "skills";
  rowId: string;
}

export function AgentContextSurface({ owner }: ScopeSurfaceRenderContext) {
  const { refresh, state } = useAgentContextInstructions({
    ownerKey: owner.ownerKey,
    projectPath: owner.projectPath,
    spacePath: owner.spacePath,
  });
  const detailController = useOptionalSystemCollectionDetailController();
  const [openedRow, setOpenedRow] = useState<OpenedAgentContextRow | null>(
    null,
  );
  const [artifactOpeners, setArtifactOpeners] = useState<
    readonly ArtifactOpener[]
  >([]);
  const instanceKey = `agent-context:${owner.ownerKey}`;
  const refreshing = state.phase === "ready" && state.refreshing;
  const instructionsState = toPresentationState(
    state,
    (snapshot) => snapshot.rows,
    (snapshot) => snapshot.instructionDiagnostics,
    <AgentContextInstructionsEmpty />,
  );
  const skillsState = toPresentationState(
    state,
    (snapshot) => snapshot.skills,
    (snapshot) => snapshot.skillDiagnostics,
    <AgentContextSkillsEmpty />,
  );
  const instructionsPresentation = useMemo(
    () =>
      createAgentContextInstructionsPresentation({
        artifactOpeners,
        onOpenArtifact: ({ canonicalArtifactPath, ownerRoot, tool }) =>
          openAgentContextArtifact({ canonicalArtifactPath, ownerRoot }, tool),
        onDetailRequested: (rowId) =>
          setOpenedRow({ presentationId: "instructions", rowId }),
        onRefresh: refresh,
        refreshing,
        state: instructionsState,
      }),
    [artifactOpeners, instructionsState, refresh, refreshing],
  );
  const skillsPresentation = useMemo(
    () =>
      createAgentContextSkillsPresentation({
        artifactOpeners,
        onOpenArtifact: ({ canonicalArtifactPath, ownerRoot, tool }) =>
          openAgentContextArtifact({ canonicalArtifactPath, ownerRoot }, tool),
        onDetailRequested: (rowId) =>
          setOpenedRow({ presentationId: "skills", rowId }),
        onRefresh: refresh,
        refreshing,
        state: skillsState,
      }),
    [artifactOpeners, refresh, refreshing, skillsState],
  );
  const instance = useMemo<SystemCollectionInstance>(
    () => ({
      defaultPresentationId: "instructions",
      instanceKey,
      presentations: [instructionsPresentation, skillsPresentation],
      stateScope: "session",
    }),
    [instanceKey, instructionsPresentation, skillsPresentation],
  );
  const collectionState = useSystemCollectionState(instance);

  useEffect(() => {
    let cancelled = false;
    void listAgentContextArtifactOpeners().then(
      (openers) => {
        if (!cancelled) setArtifactOpeners(openers);
      },
      () => {
        if (!cancelled) setArtifactOpeners([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!openedRow || state.phase !== "ready" || !detailController) return;
    const rows =
      openedRow.presentationId === "instructions"
        ? state.snapshot.rows
        : state.snapshot.skills;
    if (rows.some((row) => row.id === openedRow.rowId)) return;

    void detailController.close({
      instanceKey,
      presentationId: openedRow.presentationId,
      rowId: openedRow.rowId,
    });
  }, [detailController, instanceKey, openedRow, state]);

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

function toPresentationState<Row>(
  state: AgentContextCatalogState,
  selectRows: (
    snapshot: Extract<AgentContextCatalogState, { phase: "ready" }>["snapshot"],
  ) => readonly Row[],
  selectDiagnostics: (
    snapshot: Extract<AgentContextCatalogState, { phase: "ready" }>["snapshot"],
  ) => readonly string[],
  sourceEmpty: React.ReactNode,
): SystemCollectionPresentationState<Row> {
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

  const diagnostics = selectDiagnostics(state.snapshot).map(
    (diagnostic, index) => (
      <span key={`${diagnostic}:${index}`}>{diagnostic}</span>
    ),
  );
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
    rows: selectRows(state.snapshot),
    sourceEmpty,
  };
}
