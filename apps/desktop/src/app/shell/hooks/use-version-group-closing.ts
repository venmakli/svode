import { useEffect, useRef } from "react";
import {
  useActiveContentPath,
  useActiveContentSpaceId,
} from "@/features/artifact";
import {
  closeAllVersionGroups,
  closeLeftVersionGroup,
} from "@/features/git/app-shell";
import { getSpaceSnapshot, useSpace } from "@/features/space";

/**
 * The moments of the window that close open content groups of automatic
 * versions (Stage 11 1.E): leaving the Page or Collection shown in the main
 * area, and leaving the window. Desktop decides whether versions are on for
 * the repository and which groups closed.
 */
export function useVersionGroupClosing() {
  const activePath = useActiveContentPath();
  const activeSpaceId = useActiveContentSpaceId();
  const spacePath = useSpace((state) => {
    const id = activeSpaceId ?? state.activeRootId;
    if (!id) return null;
    if (id === state.activeRootId) return state.activeRootPath;
    return state.spaces.find((space) => space.id === id)?.path ?? null;
  });
  const shown = useRef<{ spacePath: string; path: string } | null>(null);

  useEffect(() => {
    const previous = shown.current;
    shown.current =
      spacePath && activePath ? { spacePath, path: activePath } : null;
    if (
      previous &&
      (previous.spacePath !== spacePath || previous.path !== activePath)
    )
      void closeLeftVersionGroup(previous.spacePath, previous.path).catch(
        (error) => console.debug("closing a version group failed:", error),
      );
  }, [activePath, spacePath]);

  useEffect(() => {
    const onBlur = () => {
      const state = getSpaceSnapshot();
      const paths = [
        state.activeRootPath,
        ...state.spaces.map((space) => space.path),
      ].filter((path): path is string => !!path);
      if (paths.length === 0) return;
      void closeAllVersionGroups(paths).catch((error) =>
        console.debug("closing version groups failed:", error),
      );
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);
}
