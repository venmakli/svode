import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { renameSpace } from "../api/space-actions";
import type { SpaceInfo } from "../model";

interface UseSpaceSidebarRenameInput {
  activeRootPath: string | null;
  patchSpaceMetadata: (
    spacePath: string,
    updates: { name?: string; icon?: string; description?: string },
  ) => void;
  spaces: SpaceInfo[];
}

export function useSpaceSidebarRename({
  activeRootPath,
  patchSpaceMetadata,
  spaces,
}: UseSpaceSidebarRenameInput) {
  const [editingSpaceId, setEditingSpaceId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingSpaceId && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editingSpaceId]);

  const handleRenameSpace = useCallback(async () => {
    if (!activeRootPath) {
      setEditingSpaceId(null);
      return;
    }

    const space = spaces.find((item) => item.id === editingSpaceId);
    const nextName = editValue.trim();
    if (!space || !nextName || nextName === space.name) {
      setEditingSpaceId(null);
      return;
    }

    try {
      await renameSpace({
        spacePath: space.path,
        name: nextName,
        projectPath: activeRootPath,
      });
      patchSpaceMetadata(space.path, { name: nextName });
    } catch (err) {
      console.error("Failed to rename space:", err);
      toast.error(m.toast_error());
    }
    setEditingSpaceId(null);
  }, [activeRootPath, editValue, editingSpaceId, patchSpaceMetadata, spaces]);

  return {
    editRef,
    editingSpaceId,
    editValue,
    handleRenameSpace,
    setEditingSpaceId,
    setEditValue,
  };
}
