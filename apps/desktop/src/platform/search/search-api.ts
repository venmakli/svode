import { invokeCommand } from "@/platform/native/invoke";
import type { SearchResponseDto, SearchScopeDto } from "./search-types";

export interface SearchProjectPagesByTitleInputDto extends Record<
  string,
  unknown
> {
  projectPath: string;
  query: string;
  limit?: number;
  scope?: SearchScopeDto;
}

export function searchProjectPagesByTitle(
  input: SearchProjectPagesByTitleInputDto,
): Promise<SearchResponseDto> {
  return invokeCommand<SearchResponseDto>(
    "search_project_pages_by_title",
    input,
  );
}
