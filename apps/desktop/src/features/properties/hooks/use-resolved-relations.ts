import { useEffect, useState } from "react";
import { resolveRelationsBatch } from "../api/relation-api";
import type { RelationContext, ResolvedRelationEntry } from "../model";

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
  values: string[],
) {
  const [resolved, setResolved] = useState<
    Map<string, ResolvedRelationEntry | null>
  >(() => new Map());

  useEffect(() => {
    if (!context?.spacePath || values.length === 0) {
      return deferStateUpdate(() => setResolved(new Map()));
    }
    let cancelled = false;
    void resolveRelationsBatch({
      spacePath: context.spacePath,
      projectPath: context.projectPath,
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
  }, [context?.projectPath, context?.spacePath, relation, values]);

  return resolved;
}
