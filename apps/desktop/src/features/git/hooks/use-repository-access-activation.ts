import { useEffect } from "react";

import { repositoryAccessOwner } from "../model/repository-access-owner";

// Only content and exact settings hosts activate; passive readers do not.
export function useRepositoryAccessActivation(spacePath: string) {
  useEffect(() => {
    let release: (() => void) | undefined;
    const updateVisibility = () => {
      if (document.visibilityState === "hidden") {
        release?.();
        release = undefined;
      } else if (!release) {
        release = repositoryAccessOwner.retainActive(spacePath);
      }
    };
    const onFocus = () => {
      if (document.visibilityState !== "hidden")
        void repositoryAccessOwner.activate(spacePath);
    };
    updateVisibility();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      release?.();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, [spacePath]);
}
