import { useState } from "react";
import * as m from "@/paraglide/messages.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { MoreHorizontal, Settings, Trash2 } from "lucide-react";
import { relativeTime } from "@/lib/relative-time";
import type { SpaceInfo } from "@/types/space";

interface ProjectCardProps {
  project: SpaceInfo;
  onClick: () => void;
  onDelete: (deleteFiles: boolean) => void;
}

export function ProjectCard({ project, onClick, onDelete }: ProjectCardProps) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className="flex items-center gap-3 rounded-md px-3 py-2.5 hover:bg-accent cursor-pointer transition-colors group"
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        }}
      >
        <span className="text-xl shrink-0">{project.icon}</span>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{project.name}</p>
          <p className="text-xs text-muted-foreground truncate">
            {project.description || project.path}
          </p>
        </div>

        {project.lastOpened && (
          <span className="text-xs text-muted-foreground shrink-0 hidden sm:block">
            {relativeTime(project.lastOpened)}
          </span>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 opacity-0 group-hover:opacity-100 shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled>
              <Settings className="mr-2 h-4 w-4" />
              {m.project_settings()}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                setDeleteOpen(true);
              }}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {m.project_remove()}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AlertDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open) setDeleteFiles(false);
          setDeleteOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.project_delete_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.project_delete_description()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center gap-2 py-2 cursor-pointer">
            <Checkbox
              checked={deleteFiles}
              onCheckedChange={(checked) => setDeleteFiles(checked === true)}
            />
            <span className="text-sm text-destructive">
              {m.project_delete_files()}
            </span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.project_cancel()}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => onDelete(deleteFiles)}
            >
              {m.project_delete_confirm()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
