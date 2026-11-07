import { useEffect, useRef } from "react";

import type { ScopeOpenItem } from "@/features/scope-surfaces";

import { attachmentOpenFolderStep } from "../model/activation";
import type { AttachmentActivationRequest } from "../model/types";
import type { useAttachmentsSource } from "./use-attachments-source";

/**
 * The folder the open request of the surface addresses opens in its peek
 * once, as a click on its row does; a folder that is gone opens nothing.
 */
export function useAttachmentsOpenFolder(
  openItem: ScopeOpenItem | undefined,
  {
    state,
    branches,
    inventory,
    loadBranch,
  }: ReturnType<typeof useAttachmentsSource>,
  openPeek: (target: AttachmentActivationRequest) => void,
) {
  const requestedBranches = useRef(new Set<string>());
  useEffect(() => {
    if (!openItem || state.phase === "initial") return;
    const snapshot = state.phase === "ready" ? inventory() : null;
    const step = snapshot
      ? attachmentOpenFolderStep(snapshot, branches, openItem.id)
      : ({ kind: "missing" } as const);
    if (step.kind === "wait") return;
    if (
      step.kind === "load" &&
      !requestedBranches.current.has(step.branchPath)
    ) {
      requestedBranches.current.add(step.branchPath);
      void loadBranch(step.branchPath);
      return;
    }
    openItem.consume();
    requestedBranches.current.clear();
    if (step.kind !== "open" || !snapshot) return;
    openPeek({
      activation: { itemId: step.item.key },
      mode: "peek",
      owner: snapshot.owner,
      item: step.item,
      sourceGeneration: snapshot.generation,
    });
  }, [branches, inventory, loadBranch, openItem, openPeek, state]);
}
