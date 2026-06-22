import { useEffect, useState } from "react";
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

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const loadInlineSpaceNames = async () => {
      if (!isRoot || !projectPath || spaces.length === 0) {
        return [];
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

      return types
        .filter((entry) => entry.type === "inline")
        .map((entry) => entry.space.name);
    };

    void loadInlineSpaceNames().then((names) => {
      if (!cancelled) {
        setInlineSpaceNames(names);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [open, isRoot, projectPath, spaces]);

  return { inlineSpaceNames };
}
