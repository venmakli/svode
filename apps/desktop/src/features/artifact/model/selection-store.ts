import { create } from "zustand";
import type {
  ActiveContentSelection,
  ArtifactOpenTarget,
  ArtifactSourceShape,
  ContentPathRetarget,
  ContentRevealRequest,
  OpenArtifactOptions,
  OpenScopeOwnerOptions,
  ScopeOwnerTarget,
} from "./types";

interface ArtifactSelectionState {
  selection: ActiveContentSelection | null;
  activeRevealRequest: ContentRevealRequest | null;
  activePathRetarget: ContentPathRetarget | null;
  openArtifact: (
    target: Omit<ArtifactOpenTarget, "spaceId"> & { spaceId?: string | null },
    options?: OpenArtifactOptions,
  ) => void;
  openScopeOwner: (
    owner: ScopeOwnerTarget,
    options?: OpenScopeOwnerOptions,
  ) => void;
  retarget: (fromPath: string, path: string, spaceId?: string | null) => void;
  close: () => void;
}

let nextOpenRequestKey = 1;
let nextRevealRequestKey = 1;
let nextPathRetargetKey = 1;

export function normalizeArtifactTargetPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    /^[a-zA-Z]:\//.test(normalized)
  ) {
    throw new Error(`Artifact target must be repo-relative: ${path}`);
  }
  const segments = normalized.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Artifact target is not normalized: ${path}`);
  }
  return normalized;
}

export function inferArtifactSourceShape(path: string): ArtifactSourceShape {
  return path.split("/").at(-1)?.toLowerCase() === "readme.md"
    ? "directory"
    : "file";
}

function selectionSpaceId(selection: ActiveContentSelection | null) {
  return selection?.kind === "artifact"
    ? selection.request.intent.target.spaceId
    : (selection?.request.owner.spaceId ?? null);
}

function artifactTargetsEqual(
  left: ArtifactOpenTarget,
  right: ArtifactOpenTarget,
) {
  return (
    left.spaceId === right.spaceId &&
    left.path === right.path &&
    left.sourceShape === right.sourceShape &&
    left.semanticHint?.kind === right.semanticHint?.kind &&
    left.semanticHint?.role === right.semanticHint?.role
  );
}

function ownerTargetsEqual(left: ScopeOwnerTarget, right: ScopeOwnerTarget) {
  return (
    left.kind === right.kind &&
    left.spaceId === right.spaceId &&
    (left.kind !== "collection" ||
      (right.kind === "collection" && left.path === right.path))
  );
}

function ownerPath(owner: ScopeOwnerTarget): string | null {
  return owner.kind === "collection" ? owner.path : null;
}

function selectionPath(
  selection: ActiveContentSelection | null,
): string | null {
  return selection?.kind === "artifact"
    ? selection.request.intent.target.path
    : selection
      ? ownerPath(selection.request.owner)
      : null;
}

export const useArtifactSelectionStore = create<ArtifactSelectionState>(
  (set) => ({
    selection: null,
    activeRevealRequest: null,
    activePathRetarget: null,

    openArtifact: (input, options) =>
      set((state) => {
        const target: ArtifactOpenTarget = {
          ...input,
          path: normalizeArtifactTargetPath(input.path),
          spaceId: input.spaceId ?? selectionSpaceId(state.selection),
        };
        if (
          state.selection?.kind === "artifact" &&
          artifactTargetsEqual(state.selection.request.intent.target, target) &&
          !options?.reveal
        ) {
          return state;
        }
        return {
          selection: {
            kind: "artifact",
            request: {
              key: nextOpenRequestKey++,
              intent: { target },
            },
          },
          activeRevealRequest: options?.reveal
            ? {
                key: nextRevealRequestKey++,
                path: target.path,
                spaceId: target.spaceId,
              }
            : null,
          activePathRetarget: null,
        };
      }),

    openScopeOwner: (input, options) =>
      set((state) => {
        const owner: ScopeOwnerTarget =
          input.kind === "collection"
            ? { ...input, path: normalizeArtifactTargetPath(input.path) }
            : input;
        if (
          state.selection?.kind === "scope-owner" &&
          ownerTargetsEqual(state.selection.request.owner, owner) &&
          !options?.reveal &&
          !options?.scopeOpenIntent
        ) {
          return state;
        }
        const path = ownerPath(owner);
        return {
          selection: {
            kind: "scope-owner",
            request: {
              key: nextOpenRequestKey++,
              owner,
              intent: options?.scopeOpenIntent ?? { kind: "default" },
            },
          },
          activeRevealRequest:
            options?.reveal && path
              ? {
                  key: nextRevealRequestKey++,
                  path,
                  spaceId: owner.spaceId,
                }
              : null,
          activePathRetarget: null,
        };
      }),

    retarget: (fromPath, inputPath, spaceId) =>
      set((state) => {
        const path = normalizeArtifactTargetPath(inputPath);
        const targetSpaceId = spaceId ?? selectionSpaceId(state.selection);
        if (
          selectionPath(state.selection) !== fromPath ||
          selectionSpaceId(state.selection) !== targetSpaceId ||
          fromPath === path ||
          !state.selection
        ) {
          return state;
        }
        const selection: ActiveContentSelection =
          state.selection.kind === "artifact"
            ? {
                kind: "artifact",
                request: {
                  key: nextOpenRequestKey++,
                  intent: {
                    target: {
                      ...state.selection.request.intent.target,
                      path,
                      sourceShape: inferArtifactSourceShape(path),
                    },
                  },
                },
              }
            : state.selection.request.owner.kind === "collection"
              ? {
                  kind: "scope-owner",
                  request: {
                    ...state.selection.request,
                    owner: { ...state.selection.request.owner, path },
                  },
                }
              : state.selection;
        return {
          selection,
          activeRevealRequest:
            state.activeRevealRequest?.path === fromPath &&
            state.activeRevealRequest.spaceId === targetSpaceId
              ? { ...state.activeRevealRequest, path }
              : state.activeRevealRequest,
          activePathRetarget: {
            key: nextPathRetargetKey++,
            fromPath,
            path,
            spaceId: targetSpaceId,
          },
        };
      }),

    close: () =>
      set({
        selection: null,
        activeRevealRequest: null,
        activePathRetarget: null,
      }),
  }),
);
