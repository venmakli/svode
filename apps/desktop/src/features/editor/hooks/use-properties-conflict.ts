import { useCallback } from "react";

import { resolvePropertiesConflict } from "../api/properties-conflict-api";
import {
  choosePropertiesSide,
  getPropertiesConflict,
  resolvedFrontmatter,
  setPropertiesResolution,
  usePropertiesConflictState,
  type PropertiesResolution,
  type PropertiesSide,
} from "../model/properties-conflict";

/**
 * The properties block of the document `key` (1.F): the choices in its
 * places stay in the editor; once every place has one, Svode checks the
 * frontmatter they give, and a frontmatter that reads goes before the body
 * on the next write. `onResolved` runs when it does.
 */
export function usePropertiesConflict(
  key: string | null,
  onResolved: () => void,
) {
  const state = usePropertiesConflictState(key);

  const choose = useCallback(
    async (index: number, side: PropertiesSide) => {
      if (!key) return;
      const current = getPropertiesConflict(key);
      if (!current) return;
      const choices = choosePropertiesSide(key, index, side);
      if (!choices) return;
      let resolution: PropertiesResolution;
      try {
        resolution = await resolvePropertiesConflict(current.conflict, choices);
      } catch (error) {
        resolution = { status: "failed", message: String(error) };
      }
      setPropertiesResolution(key, current.conflict, choices, resolution);
      const applied = getPropertiesConflict(key);
      if (
        resolution.status === "resolved" &&
        applied?.conflict === current.conflict &&
        resolvedFrontmatter(applied) === resolution.frontmatter
      )
        onResolved();
    },
    [key, onResolved],
  );

  return { state, choose };
}
