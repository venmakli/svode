import { useCallback, useState, type FormEvent } from "react";
import { pickRootProjectFolder } from "../api/root-project-actions";
import type { CreateProjectSubmit } from "../model/root-project";

interface UseCreateProjectDialogInput {
  onOpenChange: (open: boolean) => void;
  onSubmit: CreateProjectSubmit;
}

export function useCreateProjectDialog({
  onOpenChange,
  onSubmit,
}: UseCreateProjectDialogInput) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("\u{1F4C1}");
  const [description, setDescription] = useState("");
  const [folderPath, setFolderPath] = useState("");

  const resetForm = useCallback(() => {
    setName("");
    setIcon("\u{1F4C1}");
    setDescription("");
    setFolderPath("");
  }, []);

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (!name.trim() || !folderPath.trim()) return;

      void onSubmit(
        name.trim(),
        icon,
        description.trim() || undefined,
        folderPath.trim(),
      );
      resetForm();
    },
    [description, folderPath, icon, name, onSubmit, resetForm],
  );

  const handleOpenChange = useCallback(
    (value: boolean) => {
      if (!value) resetForm();
      onOpenChange(value);
    },
    [onOpenChange, resetForm],
  );

  const handleBrowseFolder = useCallback(async () => {
    const selected = await pickRootProjectFolder();
    if (selected) {
      setFolderPath(selected);
    }
  }, []);

  return {
    description,
    folderPath,
    handleBrowseFolder,
    handleOpenChange,
    handleSubmit,
    icon,
    isValid: name.trim() !== "" && folderPath.trim() !== "",
    name,
    setDescription,
    setFolderPath,
    setIcon,
    setName,
  };
}
