import { useCallback, useState } from "react";
import type { EntryRevealRequest } from "@/features/entry/selection";

interface SpaceScopeRevealInput {
  activeDocument: string | null;
  activeDocumentSpaceId: string | null;
  activeRevealRequest: EntryRevealRequest | null;
  scopeId: string | null;
}

interface SpaceScopeOpenInput {
  activeRevealKey: string | null;
  manuallyCollapsedRevealKey: string | null;
  manuallyOpened: boolean;
}

interface UseSpaceScopeCollapseInput {
  activeRevealKey: string | null;
  onOpen?: () => void;
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
    (activeRevealKey !== null &&
      manuallyCollapsedRevealKey !== activeRevealKey)
  );
}

export function useSpaceScopeCollapse({
  activeRevealKey,
  onOpen,
}: UseSpaceScopeCollapseInput) {
  const [manuallyOpened, setManuallyOpened] = useState(false);
  const [manuallyCollapsedRevealKey, setManuallyCollapsedRevealKey] = useState<
    string | null
  >(null);
  const open = isSpaceScopeOpen({
    activeRevealKey,
    manuallyCollapsedRevealKey,
    manuallyOpened,
  });

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setManuallyOpened(nextOpen);
      setManuallyCollapsedRevealKey(nextOpen ? null : activeRevealKey);
      if (nextOpen) onOpen?.();
    },
    [activeRevealKey, onOpen],
  );

  return {
    handleOpenChange,
    open,
  };
}
