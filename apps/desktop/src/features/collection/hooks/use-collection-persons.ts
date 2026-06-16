import { useCallback, useEffect, useRef, useState } from "react";
import type { Person } from "@/features/properties";
import { listCollectionPersons } from "../api";

export function useCollectionPersons(spacePath: string) {
  const [persons, setPersons] = useState<Person[]>([]);
  const cacheRef = useRef<{ allTime: boolean | null; persons: Person[] }>({
    allTime: null,
    persons: [],
  });

  useEffect(() => {
    let cancelled = false;
    cacheRef.current = { allTime: null, persons: [] };
    queueMicrotask(() => {
      if (!cancelled) setPersons([]);
    });
    return () => {
      cancelled = true;
    };
  }, [spacePath]);

  const loadPersons = useCallback(
    async (allTime = false) => {
      if (cacheRef.current.allTime === allTime) {
        return cacheRef.current.persons;
      }
      const list = await listCollectionPersons(spacePath, allTime);
      cacheRef.current = { allTime, persons: list };
      setPersons((current) => (samePersons(current, list) ? current : list));
      return list;
    },
    [spacePath],
  );

  return { persons, loadPersons };
}

function samePersons(current: Person[], next: Person[]) {
  if (current.length !== next.length) return false;
  return current.every((person, index) => {
    const other = next[index];
    return (
      person.email === other.email &&
      person.name === other.name &&
      (person.commitCount ?? person.commit_count ?? 0) ===
        (other.commitCount ?? other.commit_count ?? 0) &&
      (person.lastCommitAt ?? person.last_commit_at ?? null) ===
        (other.lastCommitAt ?? other.last_commit_at ?? null) &&
      (person.isMe ?? person.is_me ?? false) ===
        (other.isMe ?? other.is_me ?? false)
    );
  });
}
