import { useEffect, useMemo } from "react";
import {
  CollectionHost,
  defineCollectionPresentation,
  useCollectionState,
  type CollectionActivationContext,
  type CollectionInstance,
} from "@/features/collection";
import { createAttachmentsPresentationDescriptor } from "../model/presentation";
import type { AttachmentItem } from "../model/types";
import { AttachmentIcon } from "./attachment-icon";
import {
  attachmentHierarchy,
  AttachmentBranchStatus,
  type AttachmentsSource,
} from "./attachment-hierarchy";

export function DirectoryPeekTable({
  path,
  ownerKey,
  source,
  onActivate,
  origin,
}: {
  origin: CollectionActivationContext;
  path: string;
  ownerKey: string;
  source: AttachmentsSource;
  onActivate(item: AttachmentItem, context: CollectionActivationContext): void;
}) {
  const { observeBranch } = source;
  useEffect(() => observeBranch(path), [observeBranch, path]);
  const branch = source.branches.get(path);
  const descriptor = createAttachmentsPresentationDescriptor({
    hierarchy: attachmentHierarchy(source),
    onActivate: (item, activation) =>
      onActivate(item, {
        ...activation,
        fallbackFocus: () =>
          activation.fallbackFocus?.() ??
          origin.returnFocus?.() ??
          origin.fallbackFocus?.() ??
          null,
      }),
    renderLeading: (item) => <AttachmentIcon item={item} />,
  });
  const presentation = defineCollectionPresentation({
    descriptor,
    state: branch?.snapshot
      ? {
          phase: "ready",
          items: branch.snapshot.items,
          diagnostics: branch.snapshot.items.length
            ? [
                <AttachmentBranchStatus
                  key="branch"
                  branch={branch}
                  onRetry={() => void source.loadBranch(path)}
                />,
              ]
            : [],
          sourceEmpty: (
            <AttachmentBranchStatus
              branch={branch}
              onRetry={() => void source.loadBranch(path)}
            />
          ),
        }
      : branch?.error
        ? {
            phase: "blocking_error",
            error: (
              <AttachmentBranchStatus
                branch={branch}
                onRetry={() => void source.loadBranch(path)}
              />
            ),
          }
        : { phase: "initial" },
  });
  const instance = useMemo<CollectionInstance>(
    () => ({
      instanceKey: `attachments-directory:${ownerKey}:${path}`,
      defaultPresentationId: "all",
      presentations: [presentation],
      stateScope: "session",
    }),
    [ownerKey, path, presentation],
  );
  const state = useCollectionState(instance);
  return state.phase === "ready" ? (
    <CollectionHost instance={instance} state={state} />
  ) : null;
}
