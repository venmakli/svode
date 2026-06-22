import { CloudUpload } from "lucide-react";
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
import { useGitPublishPrompt } from "../hooks/use-git-publish-prompt";
import * as m from "@/paraglide/messages.js";

export function CloudUploadButton() {
  const prompt = useGitPublishPrompt();

  if (!prompt.visible) return null;

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" onClick={prompt.openDialog}>
            <CloudUpload className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {m.git_cloud_upload_tooltip()}
        </TooltipContent>
      </Tooltip>

      <Dialog open={prompt.open} onOpenChange={prompt.setOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{m.git_publish_title()}</DialogTitle>
            <DialogDescription>
              {m.git_publish_description({
                count: String(prompt.commits.length),
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[240px] overflow-y-auto rounded-md border">
            {prompt.loading ? (
              <p className="p-4 text-sm text-muted-foreground">
                {m.git_unpushed_loading()}
              </p>
            ) : prompt.commits.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                {m.git_publish_empty()}
              </p>
            ) : (
              <ul className="divide-y">
                {prompt.commits.map((c) => (
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
              checked={prompt.enableAutoSync}
              onCheckedChange={(checked) =>
                prompt.setEnableAutoSync(checked === true)
              }
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
              onClick={prompt.publish}
              disabled={prompt.pushing || prompt.commits.length === 0}
            >
              {m.git_publish_action()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
