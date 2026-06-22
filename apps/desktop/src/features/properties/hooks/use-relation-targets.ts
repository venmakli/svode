import { useEffect, useState } from "react";
import type { Entry } from "@/features/entry";
import { queryRelationTargets } from "../api/relation-api";

interface UseRelationTargetsInput {
  open: boolean;
  spacePath?: string | null;
  projectPath?: string | null;
  relation: string;
  query: string;
}

export function useRelationTargets({
  open,
  spacePath,
  projectPath,
  relation,
  query,
}: UseRelationTargetsInput) {
  const [targets, setTargets] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !spacePath || !relation) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setTargets([]);
        setLoading(true);
      }
    });
    void queryRelationTargets({
      spacePath,
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
  }, [open, projectPath, query, relation, spacePath]);

  return { targets, loading };
}
