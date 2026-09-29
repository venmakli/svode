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

export function searchProjectEntriesByTitle(
  input: SearchProjectEntriesByTitleInputDto,
): Promise<SearchResponseDto> {
  return invokeCommand<SearchResponseDto>(
    "search_project_pages_by_title",
    input,
  );
}
