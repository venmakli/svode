import { useCallback } from "react";
import { toast } from "sonner";

import type { PageCover } from "../model/types";

import * as m from "@/paraglide/messages.js";
import { pickCoverImageFile, uploadCoverImage } from "../api/cover-api";

interface UseCoverUploadInput {
  projectPath: string | null;
  spacePath: string;
  pagePath: string | null;
  onCoverChange: (cover: PageCover) => void;
}

export function useCoverUpload({
  projectPath,
  spacePath,
  pagePath,
  onCoverChange,
}: UseCoverUploadInput) {
  return useCallback(async () => {
    if (!projectPath || !spacePath || !pagePath) {
      toast.error(m.toast_error());
      return;
    }

    const file = await pickCoverImageFile();
    if (!file) return;

    try {
      onCoverChange(
        await uploadCoverImage({
          file,
          projectPath,
          spacePath,
          pagePath,
        }),
      );
    } catch (err) {
      console.error("Failed to upload cover image:", err);
      toast.error(m.toast_error());
    }
  }, [pagePath, onCoverChange, projectPath, spacePath]);
}
