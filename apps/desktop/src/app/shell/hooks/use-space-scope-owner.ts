import { useMemo } from "react";

import { useSpaceTreeSync } from "@/features/space";
import {
  useScopeOwner,
  type ScopeOwnerStructure,
} from "@/features/scope-surfaces";

/**
 * The scope owner of main content and Peek, rechecked as the content tree of
 * its Space changes and confirmed gone only after this Desktop's structural
 * operations over the Space finished.
 */
export function useSpaceScopeOwner(
  input: Omit<Parameters<typeof useScopeOwner>[0], "structure">,
) {
  const spaceId = input.target?.spaceId;
  const spacePath = input.target?.spacePath;
  const revision = useSpaceTreeSync((state) =>
    spaceId ? state.childrenByParentPath[spaceId] : undefined,
  );
  const settled = useSpaceTreeSync((state) => state.treePathMutationsSettled);
  const structure = useMemo<ScopeOwnerStructure | undefined>(
    () =>
      spacePath === undefined
        ? undefined
        : { revision, settled: () => settled(spacePath) },
    [revision, settled, spacePath],
  );
  return useScopeOwner({ ...input, structure });
}
