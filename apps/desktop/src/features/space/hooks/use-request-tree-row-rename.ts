import { useCallback } from "react";
import { useSidebar } from "@/components/ui/sidebar";
import { useSpaceStore } from "../model";
import { useTreeRenameRequest } from "../model/tree-rename-request";

/** Starts the inline rename of a content tree row, showing the row first. */
export function useRequestTreeRowRename() {
  const { isMobile, setOpen, setOpenMobile } = useSidebar();
  const ensureTreePathVisible = useSpaceStore(
    (state) => state.ensureTreePathVisible,
  );
  return useCallback(
    (spaceId: string, path: string) => {
      if (isMobile) setOpenMobile(true);
      else setOpen(true);
      useTreeRenameRequest.getState().request(spaceId, path);
      void ensureTreePathVisible(spaceId, path);
    },
    [ensureTreePathVisible, isMobile, setOpen, setOpenMobile],
  );
}
