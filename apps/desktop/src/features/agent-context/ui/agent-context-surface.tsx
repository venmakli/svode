import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAgentAdapterDictionary } from "@/features/agent-adapters";
import {
  CollectionHost,
  useCollectionState,
  type CollectionInstance,
} from "@/features/collection";
import {
  createCollectionDetailActivation,
  useCollectionDetailController,
} from "@/features/collection/app-shell";
import type { ScopeSurfaceRenderContext } from "@/features/scope-surfaces";
import { useAppLocale } from "@/features/settings";

import { useAgentContext } from "../hooks/use-agent-context";
import { buildAgentContextDiagnosticReadModel } from "../model/diagnostics";
import { AgentContextDiagnosticsDialog } from "./agent-context-diagnostics-dialog";
import { toAgentContextPresentationState } from "./agent-context-presentation-state";
import {
  AGENT_CONTEXT_PRESETS,
  AgentContextPresetEmpty,
  createAgentContextPresentation,
  type AgentContextPresetId,
} from "./context-presentations";
import { createAgentContextItemDetailContent } from "./item-detail";
import { createAgentContextItemProperties } from "./item-properties";

interface OpenedAgentContextItem {
  presentationId: AgentContextPresetId;
  rowId: string;
}

export function AgentContextSurface({
  onOpenProviders,
  owner,
}: ScopeSurfaceRenderContext & {
  /** Opens App Settings "Providers", where agents are enabled. */
  onOpenProviders?: () => void;
}) {
  const { retry, state } = useAgentContext({
    ownerKey: owner.ownerKey,
    projectPath: owner.projectPath,
    spacePath: owner.spacePath,
  });
  const agents = useAgentAdapterDictionary();
  // Properties and the presets built on them carry their labels: a
  // language change rebuilds them.
  const { locale } = useAppLocale();
  const detailController = useCollectionDetailController();
  const [openedItem, setOpenedItem] = useState<OpenedAgentContextItem | null>(
    null,
  );
  // Plugins of "All" whose components are shown, for the session.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const togglePlugin = useCallback((itemId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(itemId)) next.add(itemId);
      return next;
    });
  }, []);
  const instanceKey = `agent-context:${owner.ownerKey}`;
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
  const properties = useMemo(
    () => createAgentContextItemProperties({ agents, onOpenProviders }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- labels follow the locale
    [agents, locale, onOpenProviders],
  );
  const presentations = useMemo(
    () =>
      AGENT_CONTEXT_PRESETS.map((id) =>
        createAgentContextPresentation({
          ...(id === "all"
            ? { expansion: { expanded, onToggle: togglePlugin } }
            : {}),
          id,
          onActivate: createCollectionDetailActivation({
            controller: detailController,
            createContent: (item) =>
              createAgentContextItemDetailContent(item, properties, {
                onOpenProviders,
              }),
            instanceKey,
            onRequested: (rowId) =>
              setOpenedItem({ presentationId: id, rowId }),
            presentationId: id,
          }),
          properties,
          state: toAgentContextPresentationState(
            state,
            <AgentContextPresetEmpty id={id} />,
            retry,
            onOpenProviders,
          ),
        }),
      ),
    [
      detailController,
      expanded,
      instanceKey,
      onOpenProviders,
      properties,
      retry,
      state,
      togglePlugin,
    ],
  );
  const instance = useMemo<CollectionInstance>(
    () => ({
      defaultPresentationId: "all",
      instanceKey,
      presentations,
      stateScope: "session",
    }),
    [instanceKey, presentations],
  );
  const collectionState = useCollectionState(instance);

  useEffect(() => {
    if (!openedItem || state.phase !== "ready" || !detailController) return;
    if (
      state.snapshot.items.some(
        (item) =>
          item.id === openedItem.rowId ||
          item.components.some(
            (component) => component.id === openedItem.rowId,
          ),
      )
    ) {
      return;
    }

    void detailController.close({
      instanceKey,
      presentationId: openedItem.presentationId,
      rowId: openedItem.rowId,
    });
  }, [detailController, instanceKey, openedItem, state]);

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
      <CollectionHost
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
