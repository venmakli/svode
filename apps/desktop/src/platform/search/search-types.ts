export type SearchEntryTypeDto = "page" | "table_row";

export type SearchScopeDto =
  | { kind: "project" }
  | { kind: "space"; spaceId: string | null };

export interface SearchItemDto {
  id: string;
  spaceId: string | null;
  spacePath: string;
  spaceName: string;
  path: string;
  title: string;
  type: SearchEntryTypeDto;
  tableName?: string | null;
  snippet?: string | null;
  icon: string;
}

export interface SearchResponseDto {
  items: SearchItemDto[];
  indexedSpaces: number;
  totalSpaces: number;
}
