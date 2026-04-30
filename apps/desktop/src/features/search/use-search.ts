import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SearchItem, SearchResponse } from "./types";

const DEBOUNCE_MS = 150;
const LIMIT = 10;

export interface SearchState {
  query: string;
  isEmpty: boolean;
  isLoading: boolean;
  titles: SearchItem[];
  contents: SearchItem[];
  recent: SearchItem[];
  indexedSpaces: number;
  totalSpaces: number;
}

function dedupKey(item: SearchItem): string {
  return `${item.spaceId ?? ""}::${item.path}`;
}

export function useSearch(
  query: string,
  projectPath: string | null,
): SearchState {
  const [state, setState] = useState<SearchState>({
    query,
    isEmpty: true,
    isLoading: false,
    titles: [],
    contents: [],
    recent: [],
    indexedSpaces: 0,
    totalSpaces: 0,
  });
  const reqId = useRef(0);

  useEffect(() => {
    if (!projectPath) {
      setState({
        query,
        isEmpty: true,
        isLoading: false,
        titles: [],
        contents: [],
        recent: [],
        indexedSpaces: 0,
        totalSpaces: 0,
      });
      return;
    }

    const trimmed = query.trim();
    const id = ++reqId.current;

    // Empty query → fetch recent immediately (no debounce).
    if (trimmed.length === 0) {
      setState((s) => ({ ...s, query, isEmpty: true, isLoading: true }));
      invoke<SearchResponse>("recent_project_entries", {
        projectPath,
        limit: LIMIT,
      })
        .then((res) => {
          if (id !== reqId.current) return;
          setState({
            query,
            isEmpty: true,
            isLoading: false,
            titles: [],
            contents: [],
            recent: res.items,
            indexedSpaces: res.indexedSpaces,
            totalSpaces: res.totalSpaces,
          });
        })
        .catch((err) => {
          console.error("recent_project_entries failed:", err);
          if (id !== reqId.current) return;
          setState({
            query,
            isEmpty: true,
            isLoading: false,
            titles: [],
            contents: [],
            recent: [],
            indexedSpaces: 0,
            totalSpaces: 0,
          });
        });
      return;
    }

    // Non-empty → debounce 150ms then run title + FTS in parallel.
    setState((s) => ({ ...s, query, isEmpty: false, isLoading: true }));
    const timer = setTimeout(() => {
      Promise.all([
        invoke<SearchResponse>("search_project_entries_by_title", {
          projectPath,
          query: trimmed,
          limit: LIMIT,
        }),
        invoke<SearchResponse>("search_project_entries", {
          projectPath,
          query: trimmed,
          limit: LIMIT,
        }),
      ])
        .then(([titleRes, ftsRes]) => {
          if (id !== reqId.current) return;
          const titleKeys = new Set(titleRes.items.map(dedupKey));
          const dedupedFts = ftsRes.items.filter(
            (it) => !titleKeys.has(dedupKey(it)),
          );
          setState({
            query,
            isEmpty: false,
            isLoading: false,
            titles: titleRes.items,
            contents: dedupedFts,
            recent: [],
            indexedSpaces: Math.min(
              titleRes.indexedSpaces,
              ftsRes.indexedSpaces,
            ),
            totalSpaces: Math.max(titleRes.totalSpaces, ftsRes.totalSpaces),
          });
        })
        .catch((err) => {
          console.error("search failed:", err);
          if (id !== reqId.current) return;
          setState({
            query,
            isEmpty: false,
            isLoading: false,
            titles: [],
            contents: [],
            recent: [],
            indexedSpaces: 0,
            totalSpaces: 0,
          });
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, projectPath]);

  return state;
}
