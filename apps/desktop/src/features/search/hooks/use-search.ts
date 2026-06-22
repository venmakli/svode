import { useEffect, useRef, useState } from "react";
import { recentEntries, searchEntries, searchEntriesByTitle } from "../api";
import { dedupKey } from "../lib/utils";
import type { SearchItem } from "../model";

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
    let cancelled = false;
    const id = ++reqId.current;
    const isCurrent = () => !cancelled && id === reqId.current;

    if (!projectPath) {
      queueMicrotask(() => {
        if (isCurrent()) setState({ query, isEmpty: true, ...EMPTY_STATE });
      });
      return () => {
        cancelled = true;
      };
    }

    const trimmed = query.trim();
    const isEmpty = trimmed.length === 0;
    queueMicrotask(() => {
      if (isCurrent()) {
        setState((s) => ({ ...s, query, isEmpty, isLoading: true }));
      }
    });

    // Empty query → fetch recent immediately (no debounce).
    if (isEmpty) {
      recentEntries({
        projectPath,
        limit: LIMIT,
      })
        .then((res) => {
          if (!isCurrent()) return;
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
          if (!isCurrent()) return;
          console.error("recentEntries failed:", err);
          setState({ query, isEmpty: true, ...EMPTY_STATE });
        });
      return () => {
        cancelled = true;
      };
    }

    // Non-empty → debounce 150ms then run title + FTS in parallel.
    const timer = setTimeout(() => {
      Promise.all([
        searchEntriesByTitle({
          projectPath,
          query: trimmed,
          limit: LIMIT,
        }),
        searchEntries({
          projectPath,
          query: trimmed,
          limit: LIMIT,
        }),
      ])
        .then(([titleRes, ftsRes]) => {
          if (!isCurrent()) return;
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
          if (!isCurrent()) return;
          console.error("search failed:", err);
          setState({ query, isEmpty: false, ...EMPTY_STATE });
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, projectPath]);

  return state;
}
