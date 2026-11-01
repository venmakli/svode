import { useCallback, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAgentAdapterDictionary } from "@/features/agent-adapters";
import {
  CollectionHost,
  useCollectionState,
  type CollectionInstance,
} from "@/features/collection";
import {
  CollectionItemMain,
  CollectionItemPeek,
} from "@/features/collection/app-shell";
import type { ScopeSurfaceRenderContext } from "@/features/scope-surfaces";
import { useAppLocale } from "@/features/settings";

import { useAgentContext } from "../hooks/use-agent-context";
import { useAgentContextPeek } from "../hooks/use-agent-context-peek";
import type { AgentContextPeekTarget } from "../model/detail-items";
import type { AgentContextItem } from "../model/types";
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
  mainItem,
  onExpandItem,
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
  const contextPeek = useAgentContextPeek({
    instanceKey,
    onOpenProviders,
    properties,
    snapshot: state.phase === "ready" ? state.snapshot : null,
  });
  const { activation } = contextPeek.peek;
  const presentations = useMemo(
    () =>
      AGENT_CONTEXT_PRESETS.map((id) =>
        createAgentContextPresentation({
          ...(id === "all"
            ? { expansion: { expanded, onToggle: togglePlugin } }
            : {}),
          id,
          onActivate: activation((_item: AgentContextItem, context) => ({
            instanceKey,
            itemId: context.itemId,
            kind: "item",
          })),
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
      activation,
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

  const expand = (target: AgentContextPeekTarget) =>
    target.kind === "item" && onExpandItem
      ? () => onExpandItem({ surfaceId: "context", itemId: target.itemId })
      : null;
  // A plugin's components and a skill's files open in the peek over the
  // screen, in the main area as in the Collection.
  const peekElement = (
    <CollectionItemPeek
      peek={contextPeek.peek}
      find={contextPeek.find}
      render={contextPeek.render}
      expand={expand}
    />
  );

  if (mainItem) {
    return (
      <div
        className="flex min-h-full flex-col"
        data-agent-context-surface={owner.ownerKey}
      >
        <CollectionItemMain
          main={mainItem}
          target={{ kind: "item", instanceKey, itemId: mainItem.item.itemId }}
          find={contextPeek.find}
          render={contextPeek.render}
        />
        {peekElement}
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
      {peekElement}
    </div>
  );
}
