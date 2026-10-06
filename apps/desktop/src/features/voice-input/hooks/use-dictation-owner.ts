import { useEffect, useState } from "react";
import {
  getDictationOwner,
  listenDictationOwner,
  type DictationOwnerDto,
} from "../api";

/** The composer of any window that records now; one per app. */
export function useDictationOwner(): DictationOwnerDto | null {
  const [owner, setOwner] = useState<DictationOwnerDto | null>(null);
  useEffect(() => {
    let alive = true;
    getDictationOwner()
      .then((current) => {
        if (alive) setOwner(current);
      })
      .catch(() => undefined);
    const unlisten = listenDictationOwner((next) => {
      if (alive) setOwner(next);
    });
    return () => {
      alive = false;
      void unlisten.then((stop) => stop()).catch(() => undefined);
    };
  }, []);
  return owner;
}
