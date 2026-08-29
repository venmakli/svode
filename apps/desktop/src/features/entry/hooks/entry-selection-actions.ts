import {
  closeActiveContent,
  getActiveContentSelection,
  inferArtifactSourceShape,
  openArtifact,
  openScopeOwner,
  retargetActiveContent,
  type ActiveContentSelectionSnapshot,
  type ContentPathRetarget,
  type ContentRevealRequest,
} from "@/features/artifact";
import type { ScopeOpenIntent } from "@/features/scope-surfaces";
import type { Entry } from "../model";
import { useEntryTitleOutcomeStore } from "./entry-title-outcome-store";

export interface OpenEntryDocumentOptions {
  reveal?: boolean;
  scopeOpenIntent?: ScopeOpenIntent;
}

export interface ScopeOpenRequest {
  key: number;
  intent: ScopeOpenIntent;
}

export type EntryRevealRequest = ContentRevealRequest;
export type EntryPathRetarget = ContentPathRetarget;

export type { EntryTitleOutcome } from "./entry-title-outcome-store";

export interface EntrySelectionSnapshot {
  activeDocument: string | null;
  activeDocumentSpaceId: string | null;
  activeRevealRequest: EntryRevealRequest | null;
  activeScopeOpenRequest: ScopeOpenRequest | null;
  activePathRetarget: EntryPathRetarget | null;
}

export function entrySelectionSnapshotFromContent(
  snapshot: ActiveContentSelectionSnapshot,
): EntrySelectionSnapshot {
  const { selection } = snapshot;
  const activeDocument =
    selection?.kind === "artifact"
      ? selection.request.intent.target.path
      : selection?.request.owner.kind === "collection"
        ? selection.request.owner.path
        : null;
  const activeDocumentSpaceId =
    selection?.kind === "artifact"
      ? selection.request.intent.target.spaceId
      : (selection?.request.owner.spaceId ?? null);
  const activeScopeOpenRequest =
    selection?.kind === "scope-owner"
      ? { key: selection.request.key, intent: selection.request.intent }
      : null;
  return {
    activeDocument,
    activeDocumentSpaceId,
    activeRevealRequest: snapshot.activeRevealRequest,
    activeScopeOpenRequest,
    activePathRetarget: snapshot.activePathRetarget,
  };
}

export function getActiveEntrySelection(): EntrySelectionSnapshot {
  return entrySelectionSnapshotFromContent(getActiveContentSelection());
}

export function openEntryDocument(
  path: string,
  spaceId?: string,
  options?: OpenEntryDocumentOptions,
) {
  if (path.replaceAll("\\", "/").toLowerCase() === "readme.md") {
    openScopeOwner(
      { kind: "space", spaceId: spaceId ?? null },
      { scopeOpenIntent: options?.scopeOpenIntent },
    );
    return;
  }
  if (options?.scopeOpenIntent) {
    openScopeOwner(
      { kind: "collection", spaceId: spaceId ?? null, path },
      {
        reveal: options.reveal,
        scopeOpenIntent: options.scopeOpenIntent,
      },
    );
    return;
  }
  openArtifact(
    {
      path,
      spaceId,
      sourceShape: inferArtifactSourceShape(path),
      semanticHint: { kind: "page" },
    },
    { reveal: options?.reveal },
  );
}

export function openEntryScopeHome(spaceId?: string) {
  openScopeOwner({ kind: "space", spaceId: spaceId ?? null });
}

export function retargetEntryDocument(
  fromPath: string,
  path: string,
  spaceId?: string,
) {
  retargetActiveContent(fromPath, path, spaceId);
}

export function publishEntryTitleOutcome(
  scopePath: string,
  previousPath: string,
  entry: Entry,
) {
  useEntryTitleOutcomeStore
    .getState()
    .publishTitleOutcome(scopePath, previousPath, entry);
}

export function closeEntryDocument() {
  closeActiveContent();
}
