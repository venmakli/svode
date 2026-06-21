import { useCallback, useEffect, useRef, useState } from "react";
import type { ActorCandidate } from "@/features/properties";
import { listCollectionActors } from "../api";

export function useCollectionActors(spacePath: string) {
  const [actors, setActors] = useState<ActorCandidate[]>([]);
  const cacheRef = useRef<{ allTime: boolean | null; actors: ActorCandidate[] }>({
    allTime: null,
    actors: [],
  });

  useEffect(() => {
    let cancelled = false;
    cacheRef.current = { allTime: null, actors: [] };
    queueMicrotask(() => {
      if (!cancelled) setActors([]);
    });
    return () => {
      cancelled = true;
    };
  }, [spacePath]);

  const loadActors = useCallback(
    async (allTime = false) => {
      if (cacheRef.current.allTime === allTime) {
        return cacheRef.current.actors;
      }
      const list = await listCollectionActors(spacePath, allTime);
      cacheRef.current = { allTime, actors: list };
      setActors((current) => (sameActors(current, list) ? current : list));
      return list;
    },
    [spacePath],
  );

  return { actors, loadActors };
}

function sameActors(current: ActorCandidate[], next: ActorCandidate[]) {
  if (current.length !== next.length) return false;
  return current.every((actor, index) => {
    const other = next[index];
    return (
      actor.email === other.email &&
      actor.name === other.name &&
      (actor.commitCount ?? actor.commit_count ?? 0) ===
        (other.commitCount ?? other.commit_count ?? 0) &&
      (actor.lastCommitAt ?? actor.last_commit_at ?? null) ===
        (other.lastCommitAt ?? other.last_commit_at ?? null) &&
      (actor.isMe ?? actor.is_me ?? false) ===
        (other.isMe ?? other.is_me ?? false)
    );
  });
}
