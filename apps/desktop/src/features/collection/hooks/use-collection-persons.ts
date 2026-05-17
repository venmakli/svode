import { useCallback, useState } from "react";
import type { Person } from "@/features/properties/model";
import { listCollectionPersons } from "../api";

export function useCollectionPersons(spacePath: string) {
  const [persons, setPersons] = useState<Person[]>([]);

  const loadPersons = useCallback(
    async (allTime = false) => {
      const list = await listCollectionPersons(spacePath, allTime);
      setPersons(list);
      return list;
    },
    [spacePath],
  );

  return { persons, loadPersons };
}
