import { useEffect, useRef, useState } from "react";
import { invokeCommand as invoke } from "@/platform/native/invoke";
import { dedupKey } from "./utils";
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

const EMPTY_STATE: Omit<SearchState, "query" | "isEmpty"> = {
  isLoading: false,
  titles: [],
  contents: [],
  recent: [],
  indexedSpaces: 0,
  totalSpaces: 0,
};

export function useSearch(
  query: string,
  projectPath: string | null,
): SearchState {
  const [state, setState] = useState<SearchState>({
    query,
    isEmpty: true,
    ...EMPTY_STATE,
  });
  const reqId = useRef(0);

  useEffect(() => {
    if (!projectPath) {
      setState({ query, isEmpty: true, ...EMPTY_STATE });
      return;
    }

    const trimmed = query.trim();
    const id = ++reqId.current;
    const isEmpty = trimmed.length === 0;
    setState((s) => ({ ...s, query, isEmpty, isLoading: true }));

    // Empty query → fetch recent immediately (no debounce).
    if (isEmpty) {
      invoke<SearchResponse>("recent_project_entries", {
        projectPath,
        limit: LIMIT,
      })
        .then((res) => {
          if (id !== reqId.current) return;
          setState({
            query,
            isEmpty: true,
            ...EMPTY_STATE,
            recent: res.items,
            indexedSpaces: res.indexedSpaces,
            totalSpaces: res.totalSpaces,
          });
        })
        .catch((err) => {
          console.error("recent_project_entries failed:", err);
          if (id !== reqId.current) return;
          setState({ query, isEmpty: true, ...EMPTY_STATE });
        });
      return;
    }

    // Non-empty → debounce 150ms then run title + FTS in parallel.
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
          // Both responses fan out over the same project state, so
          // total/indexed counts agree (modulo a reindex completing between
          // the two parallel calls — within ~150ms of each other). Pick
          // titleRes as the source.
          setState({
            query,
            isEmpty: false,
            isLoading: false,
            titles: titleRes.items,
            contents: dedupedFts,
            recent: [],
            indexedSpaces: titleRes.indexedSpaces,
            totalSpaces: titleRes.totalSpaces,
          });
        })
        .catch((err) => {
          console.error("search failed:", err);
          if (id !== reqId.current) return;
          setState({ query, isEmpty: false, ...EMPTY_STATE });
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, projectPath]);

  return state;
}
