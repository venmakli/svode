import { useEffect, useState } from "react";
import type { SpaceGitType, SpaceInfo } from "@/features/space";
import { getSpaceGitType } from "../api";

export type ProjectSpaceGitTypeMap = Partial<
  Record<string, SpaceGitType | null>
>;

interface UseProjectSpaceGitTypesOptions {
  open: boolean;
  active: boolean;
  projectPath: string;
  spaces: Pick<SpaceInfo, "id" | "path">[];
}

export function useProjectSpaceGitTypes({
  open,
  active,
  projectPath,
  spaces,
}: UseProjectSpaceGitTypesOptions): ProjectSpaceGitTypeMap {
  const [gitTypes, setGitTypes] = useState<ProjectSpaceGitTypeMap>({});

  useEffect(() => {
    if (!open || !active || !projectPath || spaces.length === 0) return;

    let cancelled = false;

    async function loadGitTypes() {
      const entries = await Promise.all(
        spaces.map(async (space): Promise<[string, SpaceGitType | null]> => {
          try {
            const gitType = await getSpaceGitType({
              projectPath,
              spacePath: space.path,
            });
            return [space.id, gitType];
          } catch {
            return [space.id, null];
          }
        }),
      );

      if (!cancelled) {
        setGitTypes(Object.fromEntries(entries));
      }
    }

    void loadGitTypes();

    return () => {
      cancelled = true;
    };
  }, [active, open, projectPath, spaces]);

  return gitTypes;
}
