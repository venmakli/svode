import { useEffect, useState, useCallback } from "react";
import * as m from "@/paraglide/messages.js";
import { toast } from "sonner";
import { invokeCommand as invoke } from "@/platform/native/invoke";
import { listen } from "@/platform/native/events";
import { Info } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { Progress } from "@/components/ui/progress";
import { useSpaceStore } from "../model";
import type { SpaceGitType } from "../model";
import type { CloneProgress } from "@/features/git";

interface CreateSpaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const CYRILLIC_MAP: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "yo",
  ж: "zh",
  з: "z",
  и: "i",
  й: "j",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

function slugPreview(name: string): string {
  const transliterated = name
    .toLowerCase()
    .split("")
    .map((c) => CYRILLIC_MAP[c] ?? c)
    .join("");
  return transliterated
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function folderFromUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const lastSegment = trimmed.split("/").pop() ?? "";
  return lastSegment
    .replace(/\.git$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
}

const URL_REGEX = /^(https?:\/\/)\S+|^[\w.-]+@[\w.-]+:\S+$/;

function sanitizeFolder(value: string): string {
  return value.replace(/[^a-z0-9-]/g, "").replace(/^[-.]/, "");
}

export function CreateSpaceDialog({
  open: isOpen,
  onOpenChange,
}: CreateSpaceDialogProps) {
  const { activeRootPath, createSpace, loadSpaces } = useSpaceStore();

  const [tab, setTab] = useState<"create" | "clone">("create");
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("\u{1F4C2}");
  const [url, setUrl] = useState("");
  const [folder, setFolder] = useState("");
  const [folderEdited, setFolderEdited] = useState(false);
  const [gitType, setGitType] = useState<SpaceGitType>("inline");
  const [slugCollision, setSlugCollision] = useState(false);
  const [cloneProgress, setCloneProgress] = useState<{
    phase: string;
    percent: number;
  } | null>(null);

  function resetForm() {
    setTab("create");
    setName("");
    setIcon("\u{1F4C2}");
    setUrl("");
    setFolder("");
    setFolderEdited(false);
    setGitType("inline");
    setSlugCollision(false);
    setCloneProgress(null);
  }

  // Auto-fill folder from name (create) or URL (clone) unless user edited it
  const autoFolder = tab === "create" ? slugPreview(name) : folderFromUrl(url);

  const effectiveFolder = folderEdited ? folder : autoFolder;
  const targetPath =
    activeRootPath && effectiveFolder
      ? `${activeRootPath}/${effectiveFolder}`
      : null;

  const projectFolderName = activeRootPath
    ? (activeRootPath.split("/").pop() ?? "")
    : "";

  // Reset folderEdited when switching tabs
  useEffect(() => {
    setFolderEdited(false);
    setFolder("");
    if (tab === "create") {
      setGitType("inline");
    } else {
      setGitType("independent");
    }
  }, [tab]);

  // Debounced collision check
  useEffect(() => {
    if (!targetPath || !effectiveFolder) {
      setSlugCollision(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const exists = await invoke<boolean>("path_exists", {
          path: targetPath,
        });
        if (!cancelled) setSlugCollision(exists);
      } catch {
        if (!cancelled) setSlugCollision(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [targetPath, effectiveFolder]);

  const trimmedUrl = url.trim();
  const urlValid = tab === "create" || URL_REGEX.test(trimmedUrl);

  const isCreateValid =
    tab === "create" &&
    name.trim() !== "" &&
    effectiveFolder !== "" &&
    !slugCollision;
  const isCloneValid =
    tab === "clone" &&
    trimmedUrl !== "" &&
    urlValid &&
    effectiveFolder !== "" &&
    !slugCollision;
  const isValid = isCreateValid || isCloneValid;

  const handleFolderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const sanitized = sanitizeFolder(e.target.value);
      setFolder(sanitized);
      setFolderEdited(sanitized !== "");
    },
    [],
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
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

    // Clone tab — keep dialog open, show progress
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
  }

  async function runClone(opts: {
    url: string;
    targetPath: string;
    parentPath: string;
    folderName: string;
    fallbackName: string;
    fallbackIcon: string;
    gitType: SpaceGitType;
  }) {
    setCloneProgress({ phase: "Starting", percent: 0 });

    const unlisten = await listen<CloneProgress>("clone:progress", (event) => {
      if (event.payload.spacePath !== opts.targetPath) return;
      setCloneProgress({
        phase: event.payload.phase,
        percent: event.payload.percent,
      });
    });

    try {
      await invoke("git_clone_space", {
        url: opts.url,
        targetPath: opts.targetPath,
        projectPath: opts.parentPath,
        gitType: opts.gitType,
      });
      await invoke("register_cloned_space", {
        parentPath: opts.parentPath,
        folderName: opts.folderName,
        fallbackName: opts.fallbackName,
        fallbackIcon: opts.fallbackIcon,
        url: opts.url,
        gitType: opts.gitType,
      });
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
  }

  function handleOpenChange(value: boolean) {
    if (!value) resetForm();
    onOpenChange(value);
  }

  const submitLabel =
    tab === "clone" ? m.git_clone_action() : m.project_create();

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{m.space_new_title()}</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              {m.space_add_first_description()}
            </DialogDescription>
          </DialogHeader>

          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as "create" | "clone")}
            className="mt-4"
          >
            <TabsList className="w-full">
              <TabsTrigger value="create" className="flex-1">
                {m.space_tab_create()}
              </TabsTrigger>
              <TabsTrigger value="clone" className="flex-1">
                {m.space_tab_clone()}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="create" className="mt-4">
              <div className="grid gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="space-name">{m.space_name_label()}</Label>
                  <div className="flex gap-2">
                    <EmojiPicker value={icon} onChange={setIcon} size="sm" />
                    <Input
                      id="space-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={m.space_name_placeholder()}
                      autoFocus
                    />
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label>{m.space_folder_label()}</Label>
                  <InputGroup>
                    <InputGroupAddon>
                      <InputGroupText>{projectFolderName}/</InputGroupText>
                    </InputGroupAddon>
                    <InputGroupInput
                      value={folderEdited ? folder : autoFolder}
                      onChange={handleFolderChange}
                      placeholder="folder-name"
                      className="pl-0.5! text-sm!"
                    />
                  </InputGroup>
                  {slugCollision && (
                    <p className="text-xs text-destructive">
                      {m.git_clone_folder_exists({ slug: effectiveFolder })}
                    </p>
                  )}
                </div>

                <div className="grid gap-2">
                  <Label>{m.space_type_label()}</Label>
                  <RadioGroup
                    value={gitType}
                    onValueChange={(v) => setGitType(v as SpaceGitType)}
                  >
                    <label className="flex items-start gap-3 rounded-md border p-3 cursor-pointer has-[[data-state=checked]]:border-ring">
                      <RadioGroupItem value="inline" className="mt-0.5" />
                      <div>
                        <div className="text-sm font-medium">
                          {m.space_type_inline()}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {m.space_type_inline_desc()}
                        </div>
                      </div>
                    </label>
                    <label className="flex items-start gap-3 rounded-md border p-3 cursor-pointer has-[[data-state=checked]]:border-ring">
                      <RadioGroupItem value="independent" className="mt-0.5" />
                      <div>
                        <div className="text-sm font-medium">
                          {m.space_type_independent()}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {m.space_type_independent_desc()}
                        </div>
                      </div>
                    </label>
                    <label className="flex items-start gap-3 rounded-md border p-3 cursor-pointer has-[[data-state=checked]]:border-ring">
                      <RadioGroupItem value="submodule" className="mt-0.5" />
                      <div>
                        <div className="text-sm font-medium">
                          {m.space_type_submodule()}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {m.space_type_submodule_desc()}
                        </div>
                      </div>
                    </label>
                  </RadioGroup>
                  <div className="flex items-start gap-2 rounded-md bg-muted px-2 py-2 text-xs leading-5 text-muted-foreground">
                    <Info data-icon="inline-start" />
                    <span>{m.space_pii_independent_hint()}</span>
                  </div>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="clone" className="mt-4">
              <div className="grid gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="clone-url">{m.git_clone_url_label()}</Label>
                  <Input
                    id="clone-url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://github.com/org/repo"
                    autoFocus
                  />
                  {!urlValid && trimmedUrl !== "" && (
                    <p className="text-xs text-destructive">
                      {m.git_clone_url_invalid()}
                    </p>
                  )}
                </div>

                <div className="grid gap-2">
                  <Label>{m.space_folder_label()}</Label>
                  <InputGroup>
                    <InputGroupAddon>
                      <InputGroupText>{projectFolderName}/</InputGroupText>
                    </InputGroupAddon>
                    <InputGroupInput
                      value={folderEdited ? folder : autoFolder}
                      onChange={handleFolderChange}
                      placeholder="folder-name"
                      className="pl-0.5! text-sm!"
                    />
                  </InputGroup>
                  {slugCollision && (
                    <p className="text-xs text-destructive">
                      {m.git_clone_folder_exists({ slug: effectiveFolder })}
                    </p>
                  )}
                </div>

                <div className="grid gap-2">
                  <Label>{m.space_type_label()}</Label>
                  <RadioGroup
                    value={gitType}
                    onValueChange={(v) => setGitType(v as SpaceGitType)}
                  >
                    <label className="flex items-start gap-3 rounded-md border p-3 cursor-pointer has-[[data-state=checked]]:border-ring">
                      <RadioGroupItem value="independent" className="mt-0.5" />
                      <div>
                        <div className="text-sm font-medium">
                          {m.space_type_independent()}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {m.space_type_independent_desc()}
                        </div>
                      </div>
                    </label>
                    <label className="flex items-start gap-3 rounded-md border p-3 cursor-pointer has-[[data-state=checked]]:border-ring">
                      <RadioGroupItem value="submodule" className="mt-0.5" />
                      <div>
                        <div className="text-sm font-medium">
                          {m.space_type_submodule()}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {m.space_type_submodule_desc()}
                        </div>
                      </div>
                    </label>
                  </RadioGroup>
                  <div className="flex items-start gap-2 rounded-md bg-muted px-2 py-2 text-xs leading-5 text-muted-foreground">
                    <Info data-icon="inline-start" />
                    <span>{m.space_pii_independent_hint()}</span>
                  </div>
                </div>
              </div>
            </TabsContent>
          </Tabs>

          {cloneProgress && (
            <div className="mt-4 space-y-1">
              <Progress value={cloneProgress.percent} className="h-1.5" />
              <p className="text-xs text-muted-foreground truncate">
                {cloneProgress.phase} {cloneProgress.percent}%
              </p>
            </div>
          )}

          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={!!cloneProgress}
            >
              {m.project_cancel()}
            </Button>
            <Button type="submit" disabled={!isValid || !!cloneProgress}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
