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

export function resolveEditorAssetContext(
  context: EditorAssetResolveContext | null | undefined,
  activeRootId?: string | null,
): ResolvedEditorDocumentContext | null {
  if (!context?.projectPath || !context.documentPath || !context.spacePath) {
    return null;
  }

  const spaceId = context.spaceId ?? null;
  return {
    projectPath: context.projectPath,
    spaceId,
    sourceSpaceId: spaceId && spaceId !== activeRootId ? spaceId : null,
    documentPath: context.documentPath,
    documentAbsPath: context.documentPath.startsWith("/")
      ? context.documentPath
      : joinAbs(context.spacePath, context.documentPath),
    spacePath: context.spacePath,
  };
}
