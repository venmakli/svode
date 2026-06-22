import {
  recentProjectEntries as recentProjectEntriesCommand,
  searchProjectEntries,
  searchProjectEntriesByTitle,
} from "@/platform/search/search-api";
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

export interface SearchEntriesInput {
  projectPath: string;
  query: string;
  entryType?: string | null;
  tableName?: string | null;
  limit?: number;
  scope?: SearchScope;
}

export interface RecentEntriesInput {
  projectPath: string;
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

export function searchEntries(
  input: SearchEntriesInput,
): Promise<SearchResponse> {
  return searchProjectEntries({
    projectPath: input.projectPath,
    query: input.query,
    entryType: input.entryType,
    tableName: input.tableName,
    limit: input.limit,
    scope: input.scope,
  });
}

export function recentEntries(
  input: RecentEntriesInput,
): Promise<SearchResponse> {
  return recentProjectEntriesCommand({
    projectPath: input.projectPath,
    limit: input.limit,
    scope: input.scope,
  });
}
