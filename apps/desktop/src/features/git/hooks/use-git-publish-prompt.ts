import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  isRemoteRepositoryNotEmptyError,
  getGitPublishPromptState,
  getGitUnpushedCommits,
  listenGitPublishCommits,
  publishGitCommits,
  type GitUnpushedCommit,
} from "../api/git-publish-actions";
import { selectActiveSpacePath, useSpace } from "@/features/space";
import * as m from "@/paraglide/messages.js";

export interface GitPublishPrompt {
  visible: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  commits: GitUnpushedCommit[];
  loading: boolean;
  enableAutoSync: boolean;
  setEnableAutoSync: (enabled: boolean) => void;
  pushing: boolean;
  openDialog: () => Promise<void>;
  publish: () => Promise<void>;
}

export function useGitPublishPrompt(): GitPublishPrompt {
  const spacePath = useSpace(selectActiveSpacePath);
  const activeRootPath = useSpace((state) => state.activeRootPath);
  const [visible, setVisible] = useState(false);
  const [open, setOpen] = useState(false);
  const [commits, setCommits] = useState<GitUnpushedCommit[]>([]);
  const [loading, setLoading] = useState(false);
  const [enableAutoSync, setEnableAutoSync] = useState(false);
  const [pushing, setPushing] = useState(false);

  const recompute = useCallback(async () => {
    if (!spacePath) {
      setVisible(false);
      setCommits([]);
      return;
    }

    try {
      const next = await getGitPublishPromptState(spacePath);
      setCommits(next.commits);
      setVisible(next.visible);
    } catch {
      setVisible(false);
      setCommits([]);
    }
  }, [spacePath]);

  useEffect(() => {
    void recompute();
  }, [recompute]);

  useEffect(() => {
    if (!spacePath) return;

    let unlistenCommit: (() => void) | null = null;
    let cancelled = false;

    listenGitPublishCommits((event) => {
      if (cancelled) return;
      if (event.payload.spacePath !== spacePath) return;
      void recompute();
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else unlistenCommit = unlisten;
    });

    return () => {
      cancelled = true;
      if (unlistenCommit) unlistenCommit();
    };
  }, [spacePath, recompute]);

  const openDialog = useCallback(async () => {
    if (!spacePath) return;

    setOpen(true);
    setLoading(true);
    try {
      setCommits(await getGitUnpushedCommits(spacePath));
    } catch (err) {
      console.error("git_unpushed_commits failed:", err);
      setCommits([]);
    } finally {
      setLoading(false);
    }
  }, [spacePath]);

  const publish = useCallback(async () => {
    if (!spacePath) return;

    setPushing(true);
    try {
      await publishGitCommits({
        spacePath,
        projectPath: activeRootPath,
        enableAutoSync,
      });

      toast.success(m.git_publish_success({ count: String(commits.length) }));
      setOpen(false);
      setEnableAutoSync(false);
      void recompute();
    } catch (err) {
      console.error("git_publish failed:", err);
      if (isRemoteRepositoryNotEmptyError(err)) {
        toast.error(m.git_publish_remote_not_empty());
      } else {
        toast.error(m.git_publish_failed());
      }
    } finally {
      setPushing(false);
    }
  }, [activeRootPath, commits.length, enableAutoSync, recompute, spacePath]);

  return {
    visible,
    open,
    setOpen,
    commits,
    loading,
    enableAutoSync,
    setEnableAutoSync,
    pushing,
    openDialog,
    publish,
  };
}
