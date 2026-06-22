import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  pickRootProjectFolder,
  rootProjectPathExists,
} from "../api/root-project-actions";
import {
  isProjectCloneUrlValid,
  projectCloneTargetPath,
  projectNameFromCloneUrl,
} from "../model/project-clone";
import type { CloneProjectSubmit } from "../model/root-project";

interface UseCloneProjectDialogInput {
  onOpenChange: (open: boolean) => void;
  onSubmit: CloneProjectSubmit;
}

export function useCloneProjectDialog({
  onOpenChange,
  onSubmit,
}: UseCloneProjectDialogInput) {
  const [url, setUrl] = useState("");
  const [targetFolder, setTargetFolder] = useState("");
  const [targetExists, setTargetExists] = useState(false);
  const [isCheckingTarget, setIsCheckingTarget] = useState(false);

  const resetForm = useCallback(() => {
    setUrl("");
    setTargetFolder("");
    setTargetExists(false);
    setIsCheckingTarget(false);
  }, []);

  const trimmedUrl = url.trim();
  const urlValid = trimmedUrl !== "" && isProjectCloneUrlValid(trimmedUrl);
  const repoName = projectNameFromCloneUrl(trimmedUrl, "");
  const targetPath = projectCloneTargetPath(targetFolder, trimmedUrl);

  useEffect(() => {
    if (!urlValid || !targetPath) {
      setTargetExists(false);
      setIsCheckingTarget(false);
      return;
    }

    let cancelled = false;
    setIsCheckingTarget(true);

    const timer = window.setTimeout(async () => {
      try {
        const exists = await rootProjectPathExists(targetPath);
        if (!cancelled) setTargetExists(exists);
      } catch {
        if (!cancelled) setTargetExists(false);
      } finally {
        if (!cancelled) setIsCheckingTarget(false);
      }
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [targetPath, urlValid]);

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (!urlValid || !targetFolder.trim()) return;
      void onSubmit(trimmedUrl, targetPath);
      resetForm();
    },
    [onSubmit, resetForm, targetFolder, targetPath, trimmedUrl, urlValid],
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
      setTargetFolder(selected);
    }
  }, []);

  return {
    handleBrowseFolder,
    handleOpenChange,
    handleSubmit,
    isCheckingTarget,
    isValid:
      urlValid &&
      targetFolder.trim() !== "" &&
      !targetExists &&
      !isCheckingTarget,
    repoName,
    setTargetFolder,
    setUrl,
    targetExists,
    targetFolder,
    targetPath,
    trimmedUrl,
    url,
    urlValid,
  };
}
