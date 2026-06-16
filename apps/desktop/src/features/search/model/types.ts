export interface SearchItem {
  id: string;
  spaceId: string | null;
  spacePath: string;
  spaceName: string;
  path: string;
  title: string;
  type: "page" | "table_row";
  tableName?: string | null;
  snippet?: string | null;
  icon: string;
}

export interface SearchResponse {
  items: SearchItem[];
  indexedSpaces: number;
  totalSpaces: number;
}
