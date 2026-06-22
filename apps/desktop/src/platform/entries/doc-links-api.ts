import { invokeCommand } from "@/platform/native/invoke";

export interface MakeRelativeLinkInputDto extends Record<string, unknown> {
  sourceDocPath: string;
  targetDocPath: string;
}

export interface ResolveDocLinkInputDto extends Record<string, unknown> {
  projectPath: string;
  sourceSpaceId: string | null;
  sourcePath: string;
  url: string;
}

export interface SuggestLinkFixInputDto extends Record<string, unknown> {
  projectPath: string;
  targetSpaceId: string | null;
  brokenPath: string;
}

export interface DocLinkResolveResultDto {
  targetSpaceId: string | null;
  targetSpacePath: string | null;
  targetPath: string | null;
  status: "ready" | "missing" | "broken" | "external";
  exists: boolean;
  spaceName: string;
}

export interface LinkFixSuggestionDto {
  path: string;
  label: string;
  reason: string;
}

export function makeRelativeLink(
  input: MakeRelativeLinkInputDto,
): Promise<string> {
  return invokeCommand<string>("make_relative_link", input);
}

export function resolveDocLink(
  input: ResolveDocLinkInputDto,
): Promise<DocLinkResolveResultDto> {
  return invokeCommand<DocLinkResolveResultDto>("resolve_doc_link", input);
}

export function suggestLinkFix(
  input: SuggestLinkFixInputDto,
): Promise<LinkFixSuggestionDto[]> {
  return invokeCommand<LinkFixSuggestionDto[]>("suggest_link_fix", input);
}
