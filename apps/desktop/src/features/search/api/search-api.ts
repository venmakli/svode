import { searchProjectEntriesByTitle } from "@/platform/search/search-api";
import type { SearchResponse } from "../model";

export type SearchScope =
  | { kind: "project" }
  | { kind: "space"; spaceId: string | null };

export interface SearchEntriesByTitleInput {
  projectPath: string;
  query: string;
  limit?: number;
  scope?: SearchScope;
}

export function searchEntriesByTitle(
  input: SearchEntriesByTitleInput,
): Promise<SearchResponse> {
  return searchProjectEntriesByTitle({
    projectPath: input.projectPath,
    query: input.query,
    limit: input.limit,
    scope: input.scope,
  });
}
