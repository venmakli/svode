import { useCallback } from "react";

import {
  acceptPageMerge,
  decidePageMergeProperty,
  usePageMergeState,
  type PageMergeSide,
} from "../model/page-merge";

/**
 * The Page at `path` whose frontmatter is in conflict, as its property panel
 * decides it (DF-292 R3): a side or a value of the control for each disputed
 * property, «Изменить» to decide again, «Принять» with nothing disputed. The
 * editor writes the Page once it is decided.
 */
export function usePageMerge(spacePath: string, path: string | null) {
  const state = usePageMergeState(spacePath, path);
  const choose = useCallback(
    (key: string, side: PageMergeSide) => {
      if (path) decidePageMergeProperty(spacePath, path, key, { type: side });
    },
    [path, spacePath],
  );
  const setValue = useCallback(
    async (key: string, value: unknown) => {
      if (path)
        decidePageMergeProperty(spacePath, path, key, { type: "value", value });
    },
    [path, spacePath],
  );
  const reopen = useCallback(
    (key: string) => {
      if (path) decidePageMergeProperty(spacePath, path, key, null);
    },
    [path, spacePath],
  );
  const accept = useCallback(
    (accepted: boolean) => {
      if (path) acceptPageMerge(spacePath, path, accepted);
    },
    [path, spacePath],
  );
  return { state, choose, setValue, reopen, accept };
}
