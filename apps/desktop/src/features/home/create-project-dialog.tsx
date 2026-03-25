import { useState } from "react";
import * as m from "@/paraglide/messages.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const PRESET_ICONS = [
  "\u{1F4C1}", // folder
  "\u{1F3E2}", // office
  "\u{1F4BB}", // laptop
  "\u{1F4DD}", // memo
  "\u{1F3A8}", // palette
  "\u{1F52C}", // microscope
  "\u{1F4CA}", // chart
  "\u{1F3AF}", // target
  "\u{1F680}", // rocket
  "\u{1F4A1}", // lightbulb
  "\u{1F4E3}", // megaphone
  "\u2699\uFE0F", // gear
];

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string, icon: string, description?: string) => void;
}

export function CreateProjectDialog({
  open,
  onOpenChange,
  onSubmit,
}: CreateProjectDialogProps) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState(PRESET_ICONS[0]);
  const [description, setDescription] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit(name.trim(), icon, description.trim() || undefined);
    // Reset form
    setName("");
    setIcon(PRESET_ICONS[0]);
    setDescription("");
  }

  function handleOpenChange(value: boolean) {
    if (!value) {
      setName("");
      setIcon(PRESET_ICONS[0]);
      setDescription("");
    }
    onOpenChange(value);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{m.project_new_title()}</DialogTitle>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="project-name">{m.project_name_label()}</Label>
              <div className="flex gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-10 h-9 px-0 text-lg shrink-0"
                      type="button"
                    >
                      {icon}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="grid grid-cols-6 gap-0.5 p-1.5 min-w-0 w-auto">
                    {PRESET_ICONS.map((emoji) => (
                      <DropdownMenuItem
                        key={emoji}
                        className="text-lg p-1.5 justify-center cursor-pointer"
                        onClick={() => setIcon(emoji)}
                      >
                        {emoji}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <Input
                  id="project-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={m.project_name_placeholder()}
                  autoFocus
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="project-description">
                {m.project_description_label()}
              </Label>
              <Textarea
                id="project-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={m.project_description_placeholder()}
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              {m.project_cancel()}
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              {m.project_create()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
