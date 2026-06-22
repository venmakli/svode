import {
  makeRelativeLink,
  resolveDocLink as resolveDocLinkCommand,
  suggestLinkFix as suggestLinkFixCommand,
  type DocLinkResolveResultDto,
  type LinkFixSuggestionDto,
} from "@/platform/entries/doc-links-api";
import { cloneMissingSpace } from "@/platform/space/space-api";
import { makeRelativePath } from "../lib/doc-link-utils";

export type DocLinkResolveResult = DocLinkResolveResultDto;
export type LinkFixSuggestion = LinkFixSuggestionDto;

export async function makeRelativeDocUrl(
  fromAbsPath: string,
  toAbsPath: string,
): Promise<string> {
  try {
    return await makeRelativeLink({
      sourceDocPath: fromAbsPath,
      targetDocPath: toAbsPath,
    });
  } catch (err) {
    console.warn("make_relative_link failed, using frontend fallback:", err);
    return makeRelativePath(fromAbsPath, toAbsPath);
  }
}

export function resolveDocLink(input: {
  projectPath: string;
  sourceSpaceId: string | null;
  sourcePath: string;
  url: string;
}): Promise<DocLinkResolveResult> {
  return resolveDocLinkCommand(input);
}

export function suggestLinkFix(input: {
  projectPath: string;
  targetSpaceId: string | null;
  brokenPath: string;
}): Promise<LinkFixSuggestion[]> {
  return suggestLinkFixCommand(input);
}

export function cloneMissingDocLinkSpace(input: {
  projectPath: string;
  spaceId: string;
}): Promise<void> {
  return cloneMissingSpace(input.projectPath, input.spaceId);
}
