import {
  useCallback,
  useEffect,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { useSpaceStore, type SpaceGitType } from "../model";
import {
  cloneAndRegisterSpace,
  listenSpaceCloneProgress,
  type SpaceCloneProgress,
} from "../api/space-actions";
import {
  folderFromUrl,
  isCloneUrlValid,
  resolveFolderName,
  slugPreview,
  type CreateSpaceTab,
} from "../lib/space-folder-rules";
import { useSpaceActions } from "./use-space-actions";
import { useSpacePathCollision } from "./use-space-path-collision";

interface UseCreateSpaceDialogInput {
  onOpenChange: (open: boolean) => void;
}

export function useCreateSpaceDialog({
  onOpenChange,
}: UseCreateSpaceDialogInput) {
  const { activeRootPath, loadSpaces } = useSpaceStore();
  const { createSpace } = useSpaceActions();

  const [tab, setTab] = useState<CreateSpaceTab>("create");
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("\u{1F4C2}");
  const [url, setUrl] = useState("");
  const [folder, setFolder] = useState("");
  const [folderEdited, setFolderEdited] = useState(false);
  const [gitType, setGitType] = useState<SpaceGitType>("inline");
  const [cloneProgress, setCloneProgress] = useState<SpaceCloneProgress | null>(
    null,
  );

  const resetForm = useCallback(() => {
    setTab("create");
    setName("");
    setIcon("\u{1F4C2}");
    setUrl("");
    setFolder("");
    setFolderEdited(false);
    setGitType("inline");
    setCloneProgress(null);
  }, []);

  const autoFolder = tab === "create" ? slugPreview(name) : folderFromUrl(url);
  const folderInputValue = folderEdited ? folder : autoFolder;
  const resolvedFolder = resolveFolderName(folderInputValue);
  const effectiveFolder = resolvedFolder ?? "";
  const folderInvalid =
    folderEdited && folderInputValue.trim() !== "" && resolvedFolder === null;
  const targetPath =
    activeRootPath && effectiveFolder
      ? `${activeRootPath}/${effectiveFolder}`
      : null;
  const { checking: slugChecking, collision: slugCollision } =
    useSpacePathCollision(targetPath);
  const projectFolderName = activeRootPath
    ? (activeRootPath.split("/").pop() ?? "")
    : "";
  const trimmedUrl = url.trim();
  const urlValid = tab === "create" || isCloneUrlValid(trimmedUrl);
  const isCreateValid =
    tab === "create" &&
    name.trim() !== "" &&
    resolvedFolder !== null &&
    !slugChecking &&
    !slugCollision;
  const isCloneValid =
    tab === "clone" &&
    trimmedUrl !== "" &&
    urlValid &&
    resolvedFolder !== null &&
    !slugChecking &&
    !slugCollision;
  const isValid = isCreateValid || isCloneValid;
  const submitLabel =
    tab === "clone" ? m.git_clone_action() : m.project_create();

  useEffect(() => {
    setFolderEdited(false);
    setFolder("");
    setGitType(tab === "create" ? "inline" : "independent");
  }, [tab]);

  const handleFolderChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setFolder(event.target.value);
      setFolderEdited(true);
    },
    [],
  );

  const runClone = useCallback(
    async (opts: {
      url: string;
      targetPath: string;
      parentPath: string;
      folderName: string;
      fallbackName: string;
      fallbackIcon: string;
      gitType: SpaceGitType;
    }) => {
      setCloneProgress({
        spacePath: opts.targetPath,
        phase: "Starting",
        percent: 0,
      });

      const unlisten = await listenSpaceCloneProgress((progress) => {
        if (progress.spacePath !== opts.targetPath) return;
        setCloneProgress(progress);
      });

      try {
        await cloneAndRegisterSpace(opts);
        await loadSpaces(opts.parentPath);
        onOpenChange(false);
        resetForm();
      } catch (err) {
        console.error("git_clone_space failed:", err);
        toast.error(m.git_clone_failed());
        setCloneProgress(null);
      } finally {
        unlisten();
      }
    },
    [loadSpaces, onOpenChange, resetForm],
  );

  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!activeRootPath || !isValid) return;

      if (tab === "create") {
        try {
          await createSpace(
            activeRootPath,
            name.trim(),
            icon,
            effectiveFolder,
            gitType,
          );
          onOpenChange(false);
          resetForm();
        } catch (err) {
          console.error("Failed to create space:", err);
          toast.error(m.toast_error());
        }
        return;
      }

      if (!targetPath) return;
      void runClone({
        url: trimmedUrl,
        targetPath,
        parentPath: activeRootPath,
        folderName: effectiveFolder,
        fallbackName: effectiveFolder,
        fallbackIcon: "\u{1F4C2}",
        gitType,
      });
    },
    [
      activeRootPath,
      createSpace,
      effectiveFolder,
      gitType,
      icon,
      isValid,
      name,
      onOpenChange,
      resetForm,
      runClone,
      tab,
      targetPath,
      trimmedUrl,
    ],
  );

  const handleOpenChange = useCallback(
    (value: boolean) => {
      if (!value) resetForm();
      onOpenChange(value);
    },
    [onOpenChange, resetForm],
  );

  return {
    cloneProgress,
    effectiveFolder,
    folderInputValue,
    folderInvalid,
    gitType,
    handleFolderChange,
    handleOpenChange,
    handleSubmit,
    icon,
    isValid,
    name,
    projectFolderName,
    setGitType,
    setIcon,
    setName,
    setTab,
    setUrl,
    slugCollision,
    submitLabel,
    tab,
    trimmedUrl,
    url,
    urlValid,
  };
}
