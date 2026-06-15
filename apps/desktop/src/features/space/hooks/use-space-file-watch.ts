import { useEffect } from "react";
import { unwatchSpace, watchSpace } from "@/platform/space/space-api";
import { selectActiveSpacePath, useSpaceStore } from "../model";

export function useSpaceFileWatch() {
  const watchSpacePath = useSpaceStore(selectActiveSpacePath);

  useEffect(() => {
    if (!watchSpacePath) return;
    watchSpace(watchSpacePath).catch((error) =>
      console.error("Failed to watch space:", error),
    );
    return () => {
      unwatchSpace(watchSpacePath).catch((error) =>
        console.error("Failed to unwatch space:", error),
      );
    };
  }, [watchSpacePath]);
}
