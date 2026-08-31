import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  CollectionCorePresentationCore,
  useCollectionCoreState,
  type CollectionCoreInstance,
} from "@/features/collection/core";
import {
  createCollectionDetailActivation,
  useOptionalCollectionDetailController,
} from "@/features/collection/app-shell";
import type { ScopeSurfaceRenderContext } from "@/features/scope-surfaces";

import { openAgentContextArtifact } from "../api/agent-context-api";
import { useAgentContextArtifactOpeners } from "../hooks/use-agent-context-artifact-openers";
import { useAgentContextInstructions } from "../hooks/use-agent-context-instructions";
import { buildAgentContextDiagnosticReadModel } from "../model/diagnostics";
import { AgentContextDiagnosticsDialog } from "./agent-context-diagnostics-dialog";
import { toAgentContextPresentationState } from "./agent-context-presentation-state";
import {
  AgentContextInstructionsEmpty,
  createInstructionDetailContent,
  createAgentContextInstructionsPresentation,
} from "./instructions-presentation";
import {
  AgentContextSkillsEmpty,
  createSkillDetailContent,
  createAgentContextSkillsPresentation,
} from "./skills-presentation";

interface OpenedAgentContextRow {
  presentationId: "instructions" | "skills";
  rowId: string;
}

export function AgentContextSurface({ owner }: ScopeSurfaceRenderContext) {
  const { retry, state } = useAgentContextInstructions({
    ownerKey: owner.ownerKey,
    projectPath: owner.projectPath,
    spacePath: owner.spacePath,
  });
  const detailController = useOptionalCollectionDetailController();
  const [openedRow, setOpenedRow] = useState<OpenedAgentContextRow | null>(
    null,
  );
  const artifactOpeners = useAgentContextArtifactOpeners();
  const instanceKey = `agent-context:${owner.ownerKey}`;
  const instructionsState = toAgentContextPresentationState(
    state,
    (snapshot) => snapshot.rows,
    <AgentContextInstructionsEmpty />,
    retry,
  );
  const skillsState = toAgentContextPresentationState(
    state,
    (snapshot) => snapshot.skills,
    <AgentContextSkillsEmpty />,
    retry,
  );
  const diagnosticGroups = useMemo(
    () =>
      state.phase === "ready"
        ? buildAgentContextDiagnosticReadModel({
            diagnostics: state.snapshot.diagnostics,
            refreshError: state.refreshError,
          })
        : [],
    [state],
  );
  const instructionsPresentation = useMemo(
    () =>
      createAgentContextInstructionsPresentation({
        artifactOpeners,
        onOpenArtifact: ({ canonicalArtifactPath, ownerRoot, tool }) =>
          openAgentContextArtifact({ canonicalArtifactPath, ownerRoot }, tool),
        onActivate: createCollectionDetailActivation({
          controller: detailController,
          createContent: createInstructionDetailContent,
          instanceKey,
          onRequested: (rowId) =>
            setOpenedRow({ presentationId: "instructions", rowId }),
          presentationId: "instructions",
        }),
        state: instructionsState,
      }),
    [artifactOpeners, detailController, instanceKey, instructionsState],
  );
  const skillsPresentation = useMemo(
    () =>
      createAgentContextSkillsPresentation({
        artifactOpeners,
        onOpenArtifact: ({ canonicalArtifactPath, ownerRoot, tool }) =>
          openAgentContextArtifact({ canonicalArtifactPath, ownerRoot }, tool),
        onActivate: createCollectionDetailActivation({
          controller: detailController,
          createContent: createSkillDetailContent,
          instanceKey,
          onRequested: (rowId) =>
            setOpenedRow({ presentationId: "skills", rowId }),
          presentationId: "skills",
        }),
        state: skillsState,
      }),
    [artifactOpeners, detailController, instanceKey, skillsState],
  );
  const instance = useMemo<CollectionCoreInstance>(
    () => ({
      defaultPresentationId: "instructions",
      instanceKey,
      presentations: [instructionsPresentation, skillsPresentation],
      stateScope: "session",
    }),
    [instanceKey, instructionsPresentation, skillsPresentation],
  );
  const collectionState = useCollectionCoreState(instance);

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
      <CollectionCorePresentationCore
        contextualActions={
          <AgentContextDiagnosticsDialog
            groups={diagnosticGroups}
            onRetry={retry}
            retrying={state.phase === "ready" && state.retrying}
          />
        }
        instance={instance}
        state={collectionState}
      />
    </div>
  );
}
