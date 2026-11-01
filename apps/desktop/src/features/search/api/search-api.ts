import { searchProjectPagesByTitle } from "@/platform/search/search-api";
import type { SearchResponse } from "../model";

export type SearchScope =
  | { kind: "project" }
  | { kind: "space"; spaceId: string | null };

export interface SearchPagesByTitleInput {
  projectPath: string;
  query: string;
  limit?: number;
  scope?: SearchScope;
}

export function searchPagesByTitle(
  input: SearchPagesByTitleInput,
): Promise<SearchResponse> {
  return searchProjectPagesByTitle({
    projectPath: input.projectPath,
    query: input.query,
    limit: input.limit,
    scope: input.scope,
  });
}
