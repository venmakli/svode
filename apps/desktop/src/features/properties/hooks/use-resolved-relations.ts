import { useEffect, useMemo, useState } from "react";
import { useSpace } from "@/features/space";
import { resolveRelationsBatch } from "../api/relation-api";
import {
  relationTargetSpacePath,
  type RelationSpaceLookup,
} from "../lib/relation";
import type {
  RelationContext,
  RelationScope,
  ResolvedRelationEntry,
} from "../model";

function deferStateUpdate(update: () => void) {
  let cancelled = false;
  queueMicrotask(() => {
    if (!cancelled) update();
  });
  return () => {
    cancelled = true;
  };
}

export function useResolvedRelations(
  context: RelationContext | undefined,
  relation: string,
  relationScope: RelationScope | null | undefined,
  values: string[],
) {
  const [resolved, setResolved] = useState<
    Map<string, ResolvedRelationEntry | null>
  >(() => new Map());
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
    context,
    relationScope,
    lookup,
  );

  useEffect(() => {
    if (!targetSpacePath || values.length === 0) {
      return deferStateUpdate(() => setResolved(new Map()));
    }
    let cancelled = false;
    void resolveRelationsBatch({
      spacePath: targetSpacePath,
      projectPath: context?.projectPath,
      relation,
      values,
    })
      .then((items) => {
        if (cancelled) return;
        setResolved(
          new Map(values.map((item, index) => [item, items[index] ?? null])),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setResolved(new Map(values.map((item) => [item, null])));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [context?.projectPath, relation, targetSpacePath, values]);

  return resolved;
}
