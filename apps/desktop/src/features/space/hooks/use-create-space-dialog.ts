import {
  useCallback,
  useEffect,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import {
  gitAuthChallengeFromRemoteUrl,
  isGitAuthRequiredError,
  saveGitRemoteCredentials,
  type GitAuthChallenge,
  type GitRemoteAuthCredentials,
} from "@/features/git";
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
  const [cloneAuthChallenge, setCloneAuthChallenge] =
    useState<GitAuthChallenge | null>(null);
  const [cloneAuthOpen, setCloneAuthOpen] = useState(false);
  const [cloneAuthSaving, setCloneAuthSaving] = useState(false);
  const [cloneAuthError, setCloneAuthError] = useState<string | null>(null);
  const [pendingClone, setPendingClone] = useState<
    Parameters<typeof cloneAndRegisterSpace>[0] | null
  >(null);

  const resetForm = useCallback(() => {
    setTab("create");
    setName("");
    setIcon("\u{1F4C2}");
    setUrl("");
    setFolder("");
    setFolderEdited(false);
    setGitType("inline");
    setCloneProgress(null);
    setCloneAuthChallenge(null);
    setCloneAuthOpen(false);
    setCloneAuthError(null);
    setPendingClone(null);
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
        if (isGitAuthRequiredError(err)) {
          setPendingClone(opts);
          setCloneAuthChallenge(
            gitAuthChallengeFromRemoteUrl({
              remoteUrl: opts.url,
              operation: "clone",
              detail:
                typeof err === "string"
                  ? err
                  : ((err as Error)?.message ?? null),
            }),
          );
          setCloneAuthError(null);
          setCloneAuthOpen(true);
          setCloneProgress(null);
          return;
        }

        console.error("git_clone_space failed:", err);
        toast.error(m.git_clone_failed());
        setCloneProgress(null);
      } finally {
        unlisten();
      }
    },
    [loadSpaces, onOpenChange, resetForm],
  );

  const setCloneAuthDialogOpen = useCallback((open: boolean) => {
    setCloneAuthOpen(open);
    if (!open) {
      setCloneAuthError(null);
      setCloneAuthChallenge(null);
      setPendingClone(null);
    }
  }, []);

  const saveCloneAuthAndRetry = useCallback(
    async (credentials: GitRemoteAuthCredentials) => {
      if (!cloneAuthChallenge?.remoteUrl || !pendingClone || cloneAuthSaving) {
        return;
      }
      setCloneAuthSaving(true);
      setCloneAuthError(null);
      try {
        await saveGitRemoteCredentials({
          remoteUrl: cloneAuthChallenge.remoteUrl,
          username: credentials.username,
          password: credentials.password,
        });
        const retry = pendingClone;
        setCloneAuthOpen(false);
        setCloneAuthChallenge(null);
        setPendingClone(null);
        await runClone(retry);
      } catch (err) {
        console.error("git clone credential save failed:", err);
        setCloneAuthError(m.git_remote_auth_save_failed());
      } finally {
        setCloneAuthSaving(false);
      }
    },
    [cloneAuthChallenge, cloneAuthSaving, pendingClone, runClone],
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
    cloneAuthChallenge,
    cloneAuthError,
    cloneAuthOpen,
    cloneAuthSaving,
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
    saveCloneAuthAndRetry,
    setCloneAuthDialogOpen,
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
