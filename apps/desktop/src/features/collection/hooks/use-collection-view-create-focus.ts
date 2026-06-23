import { useCallback, useState } from "react";
import type { CollectionView, ViewType } from "@/features/collection/query";
import { viewType } from "../lib/utils";

export interface ViewCreateRequest {
  signal: number;
  asFolder: boolean;
}

type ViewCreateRequests = Record<ViewType, ViewCreateRequest>;

const initialRequests: ViewCreateRequests = {
  table: { signal: 0, asFolder: false },
  board: { signal: 0, asFolder: false },
  calendar: { signal: 0, asFolder: false },
  list: { signal: 0, asFolder: false },
  gallery: { signal: 0, asFolder: false },
};

export function useCollectionViewCreateFocus(
  activeView: CollectionView | null,
) {
  const [requests, setRequests] = useState<ViewCreateRequests>(initialRequests);

  const focusViewCreate = useCallback((type: ViewType, asFolder: boolean) => {
    setRequests((current) => ({
      ...current,
      [type]: {
        signal: current[type].signal + 1,
        asFolder,
      },
    }));
  }, []);

  const focusActiveViewCreate = useCallback(
    (asFolder: boolean) => {
      if (!activeView) return false;
      focusViewCreate(viewType(activeView), asFolder);
      return true;
    },
    [activeView, focusViewCreate],
  );

  return {
    focusActiveViewCreate,
    focusViewCreate,
    requests,
  };
}
