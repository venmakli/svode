import { useCallback } from "react";
import { toast } from "sonner";
import { getNativeErrorMessage } from "@/platform/native/errors";
import { navigationKeyId, type NavigationItem } from "../model/keys";
import { useNavigationState } from "./use-navigation-state";
import * as m from "@/paraglide/messages.js";

export interface KeepInNow {
  /** The object can be kept: it has an identity and is not pinned or kept. */
  available: boolean;
  pending: boolean;
  keep: () => void;
}

/** "Keep in Now" of one object; it adds the object without opening it. */
export function useKeepInNow(item: NavigationItem | null): KeepInNow {
  const id = item ? navigationKeyId(item.key) : null;
  const listed = useNavigationState((state) =>
    id
      ? [...state.pinned, ...state.kept].some(
          (listedItem) => navigationKeyId(listedItem.key) === id,
        )
      : false,
  );
  const pending = useNavigationState((state) =>
    id ? state.pendingKeyIds.has(id) : false,
  );
  const keepItem = useNavigationState((state) => state.keep);

  const keep = useCallback(() => {
    if (!item) return;
    keepItem(item).catch((error: unknown) => {
      toast.error(m.navigation_keep_failed(), {
        description: getNativeErrorMessage(error),
      });
    });
  }, [item, keepItem]);

  return { available: item !== null && !listed, pending, keep };
}
