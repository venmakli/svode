import { useCallback } from "react";
import { toast } from "sonner";
import { getNativeErrorMessage } from "@/platform/native/errors";
import { navigationKeyId, type NavigationItem } from "../model/keys";
import { useNavigationState } from "./use-navigation-state";
import * as m from "@/paraglide/messages.js";

export interface PinToggle {
  /** The object can be pinned now; a session without identity cannot. */
  available: boolean;
  pinned: boolean;
  pending: boolean;
  toggle: () => void;
}

/** Pin state and the Pin/Unpin action of one object. */
export function usePinToggle(item: NavigationItem | null): PinToggle {
  const id = item ? navigationKeyId(item.key) : null;
  const pinned = useNavigationState((state) =>
    id ? state.pinned.some((pin) => navigationKeyId(pin.key) === id) : false,
  );
  const pending = useNavigationState((state) =>
    id ? state.pendingKeyIds.has(id) : false,
  );
  const pin = useNavigationState((state) => state.pin);
  const unpin = useNavigationState((state) => state.unpin);

  const toggle = useCallback(() => {
    if (!item) return;
    const change = pinned ? unpin(item.key) : pin(item);
    change.catch((error: unknown) => {
      toast.error(m.navigation_pin_failed(), {
        description: getNativeErrorMessage(error),
      });
    });
  }, [item, pin, pinned, unpin]);

  return { available: item !== null, pinned, pending, toggle };
}
