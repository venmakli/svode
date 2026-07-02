import { useEffect, useMemo, useState } from "react";
import { useSpace } from "@/features/space";
import { queryRelationTargets } from "../api/relation-api";
import {
  relationTargetSpacePath,
  type RelationSpaceLookup,
} from "../lib/relation";
import type { RelationScope, RelationTarget } from "../model";

interface UseRelationTargetsInput {
  open: boolean;
  spacePath?: string | null;
  projectPath?: string | null;
  relation: string;
  relationScope?: RelationScope | null;
  query: string;
}

export function useRelationTargets({
  open,
  spacePath,
  projectPath,
  relation,
  relationScope,
  query,
}: UseRelationTargetsInput) {
  const [targets, setTargets] = useState<RelationTarget[]>([]);
  const [loading, setLoading] = useState(false);
  const activeRootPath = useSpace((state) => state.activeRootPath);
  const spaces = useSpace((state) => state.spaces);
  const lookup = useMemo<RelationSpaceLookup>(
    () => ({
      activeRootPath,
      spaces: spaces.map((space) => ({
        id: space.id,
        path: space.path,
      })),
    }),
    [activeRootPath, spaces],
  );
  const targetSpacePath = relationTargetSpacePath(
    spacePath ? { spacePath, projectPath } : undefined,
    relationScope,
    lookup,
  );

  useEffect(() => {
    if (!open || !targetSpacePath || !relation) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) {
          setTargets([]);
          setLoading(false);
        }
      });
      return () => {
        cancelled = true;
      };
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setTargets([]);
        setLoading(true);
      }
    });
    void queryRelationTargets({
      spacePath: targetSpacePath,
      projectPath,
      relation,
      query,
    })
      .then((entries) => {
        if (!cancelled) setTargets(entries);
      })
      .catch(() => {
        if (!cancelled) setTargets([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectPath, query, relation, targetSpacePath]);

  return { targets, loading };
}
