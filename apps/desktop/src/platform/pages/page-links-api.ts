import { invokeCommand } from "@/platform/native/invoke";

export interface MakeRelativePageLinkInputDto extends Record<string, unknown> {
  sourcePagePath: string;
  targetPagePath: string;
}

export interface ResolvePageLinkInputDto extends Record<string, unknown> {
  projectPath: string;
  sourceSpaceId: string | null;
  sourcePath: string;
  url: string;
}

export interface SuggestPageLinkFixInputDto extends Record<string, unknown> {
  projectPath: string;
  targetSpaceId: string | null;
  brokenPath: string;
}

export interface PageLinkResolveResultDto {
  targetSpaceId: string | null;
  targetSpacePath: string | null;
  targetPath: string | null;
  status: "ready" | "missing" | "broken" | "external";
  exists: boolean;
  spaceName: string;
}

export interface PageLinkFixSuggestionDto {
  path: string;
  label: string;
  reason: string;
}

export function makeRelativePageLink(
  input: MakeRelativePageLinkInputDto,
): Promise<string> {
  return invokeCommand<string>("make_relative_link", {
    sourceDocPath: input.sourcePagePath,
    targetDocPath: input.targetPagePath,
  });
}

export function resolvePageLink(
  input: ResolvePageLinkInputDto,
): Promise<PageLinkResolveResultDto> {
  return invokeCommand<PageLinkResolveResultDto>("resolve_doc_link", input);
}

export function suggestPageLinkFix(
  input: SuggestPageLinkFixInputDto,
): Promise<PageLinkFixSuggestionDto[]> {
  return invokeCommand<PageLinkFixSuggestionDto[]>("suggest_link_fix", input);
}
