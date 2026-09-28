import { getScopeOwnerFacts as getScopeOwnerFactsDto } from "@/platform/space/content-tree-api";
import type { ScopeOwnerFacts } from "../model/owner-facts";

const IDENTITY = {
  pageFile: "page-file",
  pageDirectory: "page-directory",
  collectionDirectory: "collection-directory",
  appDirectory: "app-directory",
} as const;

export async function getScopeOwnerFacts(input: {
  spacePath: string;
  path: string;
}): Promise<ScopeOwnerFacts> {
  const facts = await getScopeOwnerFactsDto(input.spacePath, input.path);
  return {
    identity: IDENTITY[facts.identity],
    ownerPath: facts.ownerPath,
    contentPath: facts.contentPath,
    hasApp: facts.hasApp,
  };
}
