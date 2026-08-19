import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  SystemCollectionPresentationCore,
  useOptionalSystemCollectionDetailController,
  useSystemCollectionState,
  type SystemCollectionInstance,
} from "@/features/collection/system";
import type { ScopeSurfaceRenderContext } from "@/features/scope-surfaces";

import { openAgentContextArtifact } from "../api/agent-context-api";
import { useAgentContextArtifactOpeners } from "../hooks/use-agent-context-artifact-openers";
import { useAgentContextInstructions } from "../hooks/use-agent-context-instructions";
import { buildAgentContextDiagnosticReadModel } from "../model/diagnostics";
import { AgentContextDiagnosticsDialog } from "./agent-context-diagnostics-dialog";
import { toAgentContextPresentationState } from "./agent-context-presentation-state";
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
  const { retry, state } = useAgentContextInstructions({
    ownerKey: owner.ownerKey,
    projectPath: owner.projectPath,
    spacePath: owner.spacePath,
  });
  const detailController = useOptionalSystemCollectionDetailController();
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
        onDetailRequested: (rowId) =>
          setOpenedRow({ presentationId: "instructions", rowId }),
        state: instructionsState,
      }),
    [artifactOpeners, instructionsState],
  );
  const skillsPresentation = useMemo(
    () =>
      createAgentContextSkillsPresentation({
        artifactOpeners,
        onOpenArtifact: ({ canonicalArtifactPath, ownerRoot, tool }) =>
          openAgentContextArtifact({ canonicalArtifactPath, ownerRoot }, tool),
        onDetailRequested: (rowId) =>
          setOpenedRow({ presentationId: "skills", rowId }),
        state: skillsState,
      }),
    [artifactOpeners, skillsState],
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
        contextualActions={
          <AgentContextDiagnosticsDialog
            groups={diagnosticGroups}
            onRetry={retry}
            retrying={state.phase === "ready" && state.retrying}
          />
        }
        detailController={detailController ?? undefined}
        instance={instance}
        state={collectionState}
      />
    </div>
  );
}
