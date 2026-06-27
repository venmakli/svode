import * as m from "@/paraglide/messages.js";
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
import type { SpaceGitType } from "../model";
import { useCreateSpaceDialog } from "../hooks/use-create-space-dialog";

interface CreateSpaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateSpaceDialog({
  open: isOpen,
  onOpenChange,
}: CreateSpaceDialogProps) {
  const {
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
  } = useCreateSpaceDialog({ onOpenChange });

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
                      value={folderInputValue}
                      onChange={handleFolderChange}
                      placeholder="folder-name"
                      className="pl-0.5! text-sm!"
                    />
                  </InputGroup>
                  {folderInvalid && (
                    <p className="text-xs text-destructive">
                      {m.space_folder_invalid()}
                    </p>
                  )}
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
                      value={folderInputValue}
                      onChange={handleFolderChange}
                      placeholder="folder-name"
                      className="pl-0.5! text-sm!"
                    />
                  </InputGroup>
                  {folderInvalid && (
                    <p className="text-xs text-destructive">
                      {m.space_folder_invalid()}
                    </p>
                  )}
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
