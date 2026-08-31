import { useCallback } from "react";
import type { ContentRevealRequest } from "@/features/artifact";

interface SpaceScopeRevealInput {
  activeContentPath: string | null;
  activeContentSpaceId: string | null;
  activeRevealRequest: ContentRevealRequest | null;
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
  activeContentPath,
  activeContentSpaceId,
  activeRevealRequest,
  scopeId,
}: SpaceScopeRevealInput): string | null {
  if (!scopeId || activeContentSpaceId !== scopeId) return null;
  if (
    !activeContentPath ||
    !activeRevealRequest ||
    activeRevealRequest.spaceId !== scopeId ||
    activeRevealRequest.path !== activeContentPath
  ) {
    return null;
  }
  return `${activeRevealRequest.key}:${activeContentPath}`;
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
