import { useCallback } from "react";
import { toast } from "sonner";

import type { EntryCover } from "@/features/entry";
import { pickMediaFiles } from "@/platform/filesystem/native-file-picker";

import * as m from "@/paraglide/messages.js";
import { uploadCoverImage } from "../api/cover-api";

interface UseCoverUploadInput {
  projectPath: string | null;
  spacePath: string;
  documentPath: string | null;
  onCoverChange: (cover: EntryCover) => void;
}

export function useCoverUpload({
  projectPath,
  spacePath,
  documentPath,
  onCoverChange,
}: UseCoverUploadInput) {
  return useCallback(async () => {
    if (!projectPath || !spacePath || !documentPath) {
      toast.error(m.toast_error());
      return;
    }

    const files = await pickMediaFiles("image", false);
    const file = files[0];
    if (!file) return;

    try {
      onCoverChange(
        await uploadCoverImage({
          file,
          projectPath,
          spacePath,
          documentPath,
        }),
      );
    } catch (err) {
      console.error("Failed to upload cover image:", err);
      toast.error(m.toast_error());
    }
  }, [documentPath, onCoverChange, projectPath, spacePath]);
}
