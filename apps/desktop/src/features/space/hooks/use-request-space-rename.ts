import { useCallback } from "react";
import { useSidebar } from "@/components/ui/sidebar";
import { useSpaceRenameRequest } from "../model/space-rename-request";

/** Starts the inline rename of a Space row, showing the sidebar first. */
export function useRequestSpaceRename() {
  const { isMobile, setOpen, setOpenMobile } = useSidebar();
  return useCallback(
    (spaceId: string) => {
      if (isMobile) setOpenMobile(true);
      else setOpen(true);
      useSpaceRenameRequest.getState().request(spaceId);
    },
    [isMobile, setOpen, setOpenMobile],
  );
}
