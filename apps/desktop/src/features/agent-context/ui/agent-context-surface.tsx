import { useCallback, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAgentAdapterDictionary } from "@/features/agent-adapters";
import {
  CollectionHost,
  useCollectionState,
  type CollectionInstance,
} from "@/features/collection";
import { useCollectionDetailController } from "@/features/collection/app-shell";
import type { ScopeSurfaceRenderContext } from "@/features/scope-surfaces";
import { useAppLocale } from "@/features/settings";

import { useAgentContext } from "../hooks/use-agent-context";
import { useAgentContextItemDetail } from "../hooks/use-agent-context-item-detail";
import { buildAgentContextDiagnosticReadModel } from "../model/diagnostics";
import { AgentContextDiagnosticsDialog } from "./agent-context-diagnostics-dialog";
import { toAgentContextPresentationState } from "./agent-context-presentation-state";
import {
  AGENT_CONTEXT_PRESETS,
  AgentContextPresetEmpty,
  createAgentContextPresentation,
} from "./context-presentations";
import { createAgentContextItemProperties } from "./item-properties";

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
  const detail = useAgentContextItemDetail({
    controller: detailController,
    instanceKey,
    onOpenProviders,
    properties,
    snapshot: state.phase === "ready" ? state.snapshot : null,
  });
  const presentations = useMemo(
    () =>
      AGENT_CONTEXT_PRESETS.map((id) =>
        createAgentContextPresentation({
          ...(id === "all"
            ? { expansion: { expanded, onToggle: togglePlugin } }
            : {}),
          id,
          onActivate: detail.activation({ instanceKey, presentationId: id }),
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
      detail,
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
