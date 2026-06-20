import { useCallback, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Check,
  ChevronDown,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  Home,
} from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { CreateProjectDialog, CloneProjectDialog } from "@/features/home";
import { registerRootSpace, useSpace } from "@/features/space";
import { openDialog } from "@/platform/native/dialog";
import { cloneProject } from "@/platform/space/space-api";
import { useShellStore } from "./model";
import * as m from "@/paraglide/messages.js";

function getErrorDescription(err: unknown): string | undefined {
  const message =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "";

  return message.trim() || undefined;
}

interface ProjectSwitcherProps {
  className?: string;
}

export function ProjectSwitcher({ className }: ProjectSwitcherProps) {
  const navigate = useNavigate();
  const {
    rootSpaces,
    activeRootId,
    activeRootName,
    activeRootIcon,
    openRoot,
    createRoot,
    openRootFolder,
    goHome,
  } = useSpace();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false);

  function handleHome() {
    goHome();
    navigate({ to: "/" });
  }

  async function handleSwitchProject(id: string) {
    if (await openRoot(id)) {
      useShellStore.getState().openContentSurface();
      navigate({ to: "/space" });
    }
  }

  const handleCreateProject = useCallback(
    async (
      name: string,
      icon: string,
      description: string | undefined,
      path: string,
    ) => {
      try {
        const project = await createRoot(name, icon, description, path);
        setCreateDialogOpen(false);
        if (await openRoot(project.id)) {
          useShellStore.getState().openContentSurface();
          navigate({ to: "/space" });
        }
      } catch (err) {
        const errStr = String(err);
        if (errStr.includes("Project already exists")) {
          toast.info(m.home_project_already_exists());
          setCreateDialogOpen(false);
          try {
            const project = await openRootFolder(path);
            if (await openRoot(project.id)) {
              useShellStore.getState().openContentSurface();
              navigate({ to: "/space" });
            }
          } catch (openErr) {
            console.error("Failed to open existing project:", openErr);
            toast.error(m.home_open_project_error(), {
              description: getErrorDescription(openErr),
            });
          }
          return;
        }

        console.error("Failed to create project:", err);
        toast.error(m.toast_error(), {
          description: getErrorDescription(err),
        });
      }
    },
    [createRoot, openRoot, openRootFolder, navigate],
  );

  const handleOpenProjectFolder = useCallback(async () => {
    const selected = await openDialog({ directory: true });
    if (!selected) return;
    try {
      const project = await openRootFolder(selected);
      if (await openRoot(project.id)) {
        useShellStore.getState().openContentSurface();
        navigate({ to: "/space" });
      }
    } catch (err) {
      console.error("Failed to open project folder:", err);
      toast.error(m.home_open_project_error(), {
        description: getErrorDescription(err),
      });
    }
  }, [openRootFolder, openRoot, navigate]);

  const handleCloneProject = useCallback(
    async (url: string, targetPath: string) => {
      setCloneDialogOpen(false);
      try {
        const project = await cloneProject(url, targetPath);
        registerRootSpace(project);
        if (await openRoot(project.id)) {
          useShellStore.getState().openContentSurface();
          navigate({ to: "/space" });
        }
      } catch (err) {
        console.error("project_clone failed:", err);
        toast.error(m.git_clone_failed(), {
          description: getErrorDescription(err),
        });
      }
    },
    [openRoot, navigate],
  );

  return (
    <>
      <SidebarMenu className={className}>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton className="w-fit max-w-full px-1.5">
                <span className="text-base leading-none">
                  {activeRootIcon || "\u{1F4C1}"}
                </span>
                <span className="truncate font-medium">
                  {activeRootName || "Project"}
                </span>
                <ChevronDown className="opacity-50" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-max min-w-48 max-w-72 rounded-lg"
              align="start"
              side="bottom"
              sideOffset={4}
            >
              <DropdownMenuItem onClick={handleHome}>
                <Home />
                {m.sidebar_all_projects()}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setCreateDialogOpen(true)}>
                <FolderPlus />
                {m.home_create_project()}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleOpenProjectFolder}>
                <FolderOpen />
                {m.home_open_project()}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setCloneDialogOpen(true)}>
                <FolderGit2 />
                {m.home_clone_project()}
              </DropdownMenuItem>
              {rootSpaces.length > 0 && <DropdownMenuSeparator />}
              {rootSpaces.map((project) => (
                <DropdownMenuItem
                  key={project.id}
                  onClick={() => handleSwitchProject(project.id)}
                >
                  <span>{project.icon}</span>
                  <span className="truncate pr-3">{project.name}</span>
                  {project.id === activeRootId && <Check className="ml-auto" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <CreateProjectDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onSubmit={handleCreateProject}
      />
      <CloneProjectDialog
        open={cloneDialogOpen}
        onOpenChange={setCloneDialogOpen}
        onSubmit={handleCloneProject}
      />
    </>
  );
}
