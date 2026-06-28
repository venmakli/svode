import { useCallback } from "react";
import type { EntryRevealRequest } from "@/features/entry/selection";

interface SpaceScopeRevealInput {
  activeDocument: string | null;
  activeDocumentSpaceId: string | null;
  activeRevealRequest: EntryRevealRequest | null;
  scopeId: string | null;
}

export interface SpaceScopeCollapseState {
  manuallyCollapsedRevealKey: string | null;
  manuallyOpened: boolean;
}

interface SpaceScopeOpenInput extends SpaceScopeCollapseState {
  activeRevealKey: string | null;
}

interface UseSpaceScopeCollapseInput {
  activeRevealKey: string | null;
  disabled?: boolean;
  onOpen?: () => void;
  onScopeStateChange: (state: SpaceScopeCollapseState) => void;
  scopeState: SpaceScopeCollapseState;
}

export function getSpaceScopeActiveRevealKey({
  activeDocument,
  activeDocumentSpaceId,
  activeRevealRequest,
  scopeId,
}: SpaceScopeRevealInput): string | null {
  if (!scopeId || activeDocumentSpaceId !== scopeId) return null;
  if (
    !activeDocument ||
    !activeRevealRequest ||
    activeRevealRequest.spaceId !== scopeId ||
    activeRevealRequest.path !== activeDocument
  ) {
    return null;
  }
  return `${activeRevealRequest.key}:${activeDocument}`;
}

export function isSpaceScopeOpen({
  activeRevealKey,
  manuallyCollapsedRevealKey,
  manuallyOpened,
}: SpaceScopeOpenInput): boolean {
  return (
    manuallyOpened ||
    (activeRevealKey !== null && manuallyCollapsedRevealKey !== activeRevealKey)
  );
}

export function useSpaceScopeCollapse({
  activeRevealKey,
  disabled = false,
  onOpen,
  onScopeStateChange,
  scopeState,
}: UseSpaceScopeCollapseInput) {
  const open =
    !disabled &&
    isSpaceScopeOpen({
      activeRevealKey,
      manuallyCollapsedRevealKey: scopeState.manuallyCollapsedRevealKey,
      manuallyOpened: scopeState.manuallyOpened,
    });

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (disabled) return;
      onScopeStateChange({
        manuallyCollapsedRevealKey: nextOpen ? null : activeRevealKey,
        manuallyOpened: nextOpen,
      });
      if (nextOpen) onOpen?.();
    },
    [activeRevealKey, disabled, onOpen, onScopeStateChange],
  );

  return {
    handleOpenChange,
    open,
  };
}

export function collapsedSpaceScopeState(
  activeRevealKey: string | null,
): SpaceScopeCollapseState {
  return {
    manuallyCollapsedRevealKey: activeRevealKey,
    manuallyOpened: false,
  };
}

export function expandedSpaceScopeState(): SpaceScopeCollapseState {
  return {
    manuallyCollapsedRevealKey: null,
    manuallyOpened: true,
  };
}
