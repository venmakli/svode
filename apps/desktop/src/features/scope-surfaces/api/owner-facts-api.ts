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

/**
 * Svode found nothing at the path: no owner directory, file or README. Its
 * `file_not_found` error reaches the frontend as the bare message
 * "File not found: <path>", not as an object with its kind.
 */
export function isScopeOwnerNotFound(error: unknown): boolean {
  return typeof error === "string" && error.startsWith("File not found: ");
}
