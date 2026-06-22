import { invokeCommand } from "@/platform/native/invoke";
import type { SearchResponseDto, SearchScopeDto } from "./search-types";

export interface SearchProjectEntriesByTitleInputDto extends Record<
  string,
  unknown
> {
  projectPath: string;
  query: string;
  limit?: number;
  scope?: SearchScopeDto;
}

export interface SearchProjectEntriesInputDto extends Record<string, unknown> {
  projectPath: string;
  query: string;
  entryType?: string | null;
  tableName?: string | null;
  limit?: number;
  scope?: SearchScopeDto;
}

export interface RecentProjectEntriesInputDto extends Record<string, unknown> {
  projectPath: string;
  limit?: number;
  scope?: SearchScopeDto;
}

export function searchProjectEntriesByTitle(
  input: SearchProjectEntriesByTitleInputDto,
): Promise<SearchResponseDto> {
  return invokeCommand<SearchResponseDto>(
    "search_project_entries_by_title",
    input,
  );
}

export function searchProjectEntries(
  input: SearchProjectEntriesInputDto,
): Promise<SearchResponseDto> {
  return invokeCommand<SearchResponseDto>("search_project_entries", input);
}

export function recentProjectEntries(
  input: RecentProjectEntriesInputDto,
): Promise<SearchResponseDto> {
  return invokeCommand<SearchResponseDto>("recent_project_entries", input);
}
