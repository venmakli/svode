import { useCallback, useMemo, useState } from "react";
import * as m from "@/paraglide/messages.js";
import { nextSidebarTreeExpansionAction } from "../lib/sidebar-tree-expansion";
import { useSpaceStore, type SpaceInfo } from "../model";
import {
  collapsedSpaceScopeState,
  expandedSpaceScopeState,
  isSpaceScopeOpen,
  type SpaceScopeCollapseState,
} from "./use-space-scope-collapse";

interface UseSidebarTreeExpansionControlInput {
  activeRootId: string | null;
  activeRevealKeysByScopeId: Record<string, string | null>;
  spaces: SpaceInfo[];
}

const DEFAULT_SCOPE_COLLAPSE_STATE: SpaceScopeCollapseState = {
  manuallyCollapsedRevealKey: null,
  manuallyOpened: false,
};

export function useSidebarTreeExpansionControl({
  activeRootId,
  activeRevealKeysByScopeId,
  spaces,
}: UseSidebarTreeExpansionControlInput) {
  const { applySidebarTreeExpansion, expandedPaths } = useSpaceStore();
  const [scopeStateById, setScopeStateById] = useState<
    Record<string, SpaceScopeCollapseState>
  >({});

  const visibleScopeIds = useMemo(
    () => [
      ...(activeRootId ? [activeRootId] : []),
      ...spaces
        .filter((space) => space.status === "ready")
        .map((space) => space.id),
    ],
    [activeRootId, spaces],
  );

  const scopeOpenById = useMemo(
    () =>
      Object.fromEntries(
        visibleScopeIds.map((scopeId) => {
          const scopeState =
            scopeStateById[scopeId] ?? DEFAULT_SCOPE_COLLAPSE_STATE;
          return [
            scopeId,
            isSpaceScopeOpen({
              activeRevealKey: activeRevealKeysByScopeId[scopeId] ?? null,
              manuallyCollapsedRevealKey: scopeState.manuallyCollapsedRevealKey,
              manuallyOpened: scopeState.manuallyOpened,
            }),
          ];
        }),
      ),
    [activeRevealKeysByScopeId, scopeStateById, visibleScopeIds],
  );

  const action = nextSidebarTreeExpansionAction({
    expandedPaths,
    scopeOpenById,
    spaceIds: visibleScopeIds,
  });
  const label =
    action === "collapse" ? m.sidebar_collapse_all() : m.sidebar_expand_all();

  const getScopeCollapseState = useCallback(
    (scopeId: string | null) =>
      scopeId
        ? (scopeStateById[scopeId] ?? DEFAULT_SCOPE_COLLAPSE_STATE)
        : DEFAULT_SCOPE_COLLAPSE_STATE,
    [scopeStateById],
  );

  const setScopeCollapseState = useCallback(
    (scopeId: string, state: SpaceScopeCollapseState) => {
      setScopeStateById((current) => ({ ...current, [scopeId]: state }));
    },
    [],
  );

  const handleToggleExpansion = useCallback(() => {
    applySidebarTreeExpansion(visibleScopeIds, action);
    setScopeStateById((current) => {
      const next = { ...current };
      for (const scopeId of visibleScopeIds) {
        next[scopeId] =
          action === "collapse"
            ? collapsedSpaceScopeState(
                activeRevealKeysByScopeId[scopeId] ?? null,
              )
            : expandedSpaceScopeState();
      }
      return next;
    });
  }, [
    action,
    activeRevealKeysByScopeId,
    applySidebarTreeExpansion,
    visibleScopeIds,
  ]);

  return {
    action,
    getScopeCollapseState,
    handleToggleExpansion,
    label,
    setScopeCollapseState,
  };
}
