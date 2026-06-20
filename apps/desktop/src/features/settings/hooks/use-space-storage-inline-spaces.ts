import { useCallback, useEffect, useState } from "react";
import type { SpaceInfo } from "@/features/space";
import { getSpaceGitType } from "../api";

interface UseSpaceStorageInlineSpacesOptions {
  open: boolean;
  isRoot: boolean;
  projectPath: string;
  spaces: Pick<SpaceInfo, "name" | "path">[];
}

export function useSpaceStorageInlineSpaces({
  open,
  isRoot,
  projectPath,
  spaces,
}: UseSpaceStorageInlineSpacesOptions) {
  const [inlineSpaceNames, setInlineSpaceNames] = useState<string[]>([]);

  const loadInlineSpaceNames = useCallback(async () => {
    if (!isRoot || !projectPath || spaces.length === 0) {
      setInlineSpaceNames([]);
      return;
    }
    const types = await Promise.all(
      spaces.map(async (space) => {
        try {
          const type = await getSpaceGitType({
            projectPath,
            spacePath: space.path,
          });
          return { space, type };
        } catch {
          return { space, type: null };
        }
      }),
    );
    setInlineSpaceNames(
      types
        .filter((entry) => entry.type === "inline")
        .map((entry) => entry.space.name),
    );
  }, [isRoot, projectPath, spaces]);

  useEffect(() => {
    if (!open) return;
    void loadInlineSpaceNames();
  }, [open, loadInlineSpaceNames]);

  return { inlineSpaceNames };
}
