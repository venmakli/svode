import {
  recentProjectEntries as recentProjectEntriesCommand,
  searchProjectEntries,
  searchProjectEntriesByTitle,
  type RecentProjectEntriesInputDto,
  type SearchProjectEntriesByTitleInputDto,
  type SearchProjectEntriesInputDto,
} from "@/platform/search/search-api";
import type { SearchScopeDto } from "@/platform/search/search-types";
import type { SearchResponse } from "../model";

export type SearchScope = SearchScopeDto;

export type SearchEntriesByTitleInput = SearchProjectEntriesByTitleInputDto;

export type SearchEntriesInput = SearchProjectEntriesInputDto;

export type RecentEntriesInput = RecentProjectEntriesInputDto;

export function searchEntriesByTitle(
  input: SearchEntriesByTitleInput,
): Promise<SearchResponse> {
  return searchProjectEntriesByTitle(input);
}

export function searchEntries(
  input: SearchEntriesInput,
): Promise<SearchResponse> {
  return searchProjectEntries(input);
}

export function recentEntries(
  input: RecentEntriesInput,
): Promise<SearchResponse> {
  return recentProjectEntriesCommand(input);
}
