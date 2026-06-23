import { joinAbs } from "./doc-link-utils";

export interface EditorAssetResolveContext {
  documentPath: string | null;
  projectPath: string | null;
  spaceId: string | null;
  spacePath: string | null;
}

export interface ResolvedEditorDocumentContext {
  projectPath: string;
  spaceId: string | null;
  sourceSpaceId: string | null;
  documentPath: string;
  documentAbsPath: string;
  spacePath: string;
}

export interface EditorDocumentSpaceRef {
  id: string;
  path: string;
}

export interface EditorDocumentContextInput {
  activeRootId: string | null;
  documentPath: string | null;
  documentSpaceId: string | null;
  projectPath: string | null;
  rootSpaces: readonly EditorDocumentSpaceRef[];
  spaces: readonly EditorDocumentSpaceRef[];
}

function buildResolvedEditorDocumentContext({
  activeRootId,
  documentPath,
  documentSpaceId,
  projectPath,
  spacePath,
}: {
  activeRootId?: string | null;
  documentPath: string;
  documentSpaceId: string | null;
  projectPath: string;
  spacePath: string;
}): ResolvedEditorDocumentContext {
  return {
    projectPath,
    spaceId: documentSpaceId,
    sourceSpaceId:
      documentSpaceId && documentSpaceId !== activeRootId
        ? documentSpaceId
        : null,
    documentPath,
    documentAbsPath: documentPath.startsWith("/")
      ? documentPath
      : joinAbs(spacePath, documentPath),
    spacePath,
  };
}

export function resolveEditorDocumentContext({
  activeRootId,
  documentPath,
  documentSpaceId,
  projectPath,
  rootSpaces,
  spaces,
}: EditorDocumentContextInput): ResolvedEditorDocumentContext | null {
  if (!projectPath || !documentPath) return null;

  const spacePath =
    !documentSpaceId || documentSpaceId === activeRootId
      ? (rootSpaces.find((space) => space.id === documentSpaceId)?.path ??
        projectPath)
      : (spaces.find((space) => space.id === documentSpaceId)?.path ?? null);

  if (!spacePath) return null;

  return buildResolvedEditorDocumentContext({
    activeRootId,
    documentPath,
    documentSpaceId,
    projectPath,
    spacePath,
  });
}

export function resolveEditorAssetContext(
  context: EditorAssetResolveContext | null | undefined,
  activeRootId?: string | null,
): ResolvedEditorDocumentContext | null {
  if (!context?.projectPath || !context.documentPath || !context.spacePath) {
    return null;
  }

  return buildResolvedEditorDocumentContext({
    activeRootId,
    documentPath: context.documentPath,
    documentSpaceId: context.spaceId ?? null,
    projectPath: context.projectPath,
    spacePath: context.spacePath,
  });
}
