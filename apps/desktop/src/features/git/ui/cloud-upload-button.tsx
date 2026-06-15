import { useCallback, useEffect, useState } from "react";
import { invokeCommand as invoke } from "@/platform/native/invoke";
import { listen } from "@/platform/native/events";
import { CloudUpload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useGitStore } from "../model";
import { useSpaceStore, selectActiveSpacePath } from "@/features/space";
import type { GitStatus } from "../model";
import type { SpaceConfig } from "@/features/space";
import * as m from "@/paraglide/messages.js";

interface UnpushedCommit {
  sha: string;
  message: string;
  author: string;
  timestamp: string;
}

export function CloudUploadButton() {
  const spacePath = useSpaceStore(selectActiveSpacePath);
  const activeRootPath = useSpaceStore((s) => s.activeRootPath);
  const [visible, setVisible] = useState(false);
  const [open, setOpen] = useState(false);
  const [commits, setCommits] = useState<UnpushedCommit[]>([]);
  const [loading, setLoading] = useState(false);
  const [enableAutoSync, setEnableAutoSync] = useState(false);
  const [pushing, setPushing] = useState(false);

  const recompute = useCallback(async () => {
    if (!spacePath) {
      setVisible(false);
      return;
    }
    try {
      const cfg = await invoke<SpaceConfig>("get_space_config", { spacePath });
      const remote = await invoke<string | null>("git_get_remote", { spacePath });
      const hasRemote = !!remote && remote.trim().length > 0;
      const autoSync = cfg.git?.autoSync === true;
      if (!hasRemote || autoSync) {
        setVisible(false);
        return;
      }
      const list = await invoke<UnpushedCommit[]>("git_unpushed_commits", { spacePath });
      setCommits(list);
      setVisible(list.length > 0);
    } catch {
      setVisible(false);
    }
  }, [spacePath]);

  // Recompute on space change.
  useEffect(() => {
    recompute();
  }, [recompute]);

  // Recompute on every autocommit (new commit may become unpushed) or on
  // regular git status changes for the active space.
  useEffect(() => {
    if (!spacePath) return;
    let unlistenCommit: (() => void) | null = null;
    let cancelled = false;
    listen<{ spacePath: string }>("git:committed", (event) => {
      if (cancelled) return;
      if (event.payload.spacePath !== spacePath) return;
      recompute();
    }).then((u) => {
      if (cancelled) u();
      else unlistenCommit = u;
    });
    return () => {
      cancelled = true;
      if (unlistenCommit) unlistenCommit();
    };
  }, [spacePath, recompute]);

  async function openDialog() {
    if (!spacePath) return;
    setOpen(true);
    setLoading(true);
    try {
      const list = await invoke<UnpushedCommit[]>("git_unpushed_commits", { spacePath });
      setCommits(list);
    } catch (err) {
      console.error("git_unpushed_commits failed:", err);
      setCommits([]);
    } finally {
      setLoading(false);
    }
  }

  async function handlePush() {
    if (!spacePath) return;
    setPushing(true);
    try {
      const status = await invoke<GitStatus>("git_publish", { spacePath });
      useGitStore.getState().applyStatus(spacePath, status);

      if (enableAutoSync) {
        await invoke("git_enable_auto_sync", {
          spacePath,
          projectPath: activeRootPath,
        });
      }

      toast.success(m.git_publish_success({ count: String(commits.length) }));
      setOpen(false);
      setEnableAutoSync(false);
      recompute();
    } catch (err) {
      console.error("git_publish failed:", err);
      const msg = String(err);
      if (msg.includes("Remote repository is not empty")) {
        toast.error(m.git_publish_remote_not_empty());
      } else {
        toast.error(m.git_publish_failed());
      }
    } finally {
      setPushing(false);
    }
  }

  if (!visible) return null;

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" onClick={openDialog}>
            <CloudUpload className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {m.git_cloud_upload_tooltip()}
        </TooltipContent>
      </Tooltip>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{m.git_publish_title()}</DialogTitle>
            <DialogDescription>
              {m.git_publish_description({ count: String(commits.length) })}
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[240px] overflow-y-auto rounded-md border">
            {loading ? (
              <p className="p-4 text-sm text-muted-foreground">
                {m.git_unpushed_loading()}
              </p>
            ) : commits.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                {m.git_publish_empty()}
              </p>
            ) : (
              <ul className="divide-y">
                {commits.map((c) => (
                  <li key={c.sha} className="p-3 text-sm">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-xs text-muted-foreground">
                        {c.sha}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {c.author}
                      </span>
                    </div>
                    <p className="mt-1 truncate">{c.message}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <label className="flex items-start gap-2 cursor-pointer">
            <Checkbox
              checked={enableAutoSync}
              onCheckedChange={(checked) => setEnableAutoSync(checked === true)}
              className="mt-0.5"
            />
            <span className="text-sm">
              {m.git_publish_auto_label()}
              <span className="block text-xs text-muted-foreground">
                {m.git_publish_auto_hint()}
              </span>
            </span>
          </label>

          <DialogFooter>
            <Button
              onClick={handlePush}
              disabled={pushing || commits.length === 0}
            >
              {m.git_publish_action()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
