import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import * as m from "@/paraglide/messages.js";
import { openDialog } from "@/platform/native/dialog";
import { listen } from "@/platform/native/events";
import { cloneProject } from "@/platform/space/space-api";
import { toast } from "sonner";
import { FolderPlus, FolderOpen, FolderGit2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { useAppVersion } from "@/features/settings";
import { registerRootSpace, useSpace, useSpaceActions } from "@/features/space";
import { ProjectList } from "./project-list";
import { EmptyState } from "./empty-state";
import { CreateProjectDialog } from "./create-project-dialog";
import { CloneProjectDialog } from "./clone-project-dialog";
import type { CloneProgress } from "@/features/git";

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

export function HomePage() {
  const navigate = useNavigate();
  const version = useAppVersion();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false);
  const autoOpenAttempted = useRef(false);

  const {
    rootSpaces,
    isLoadingRoots,
    loadRootSpaces,
    openRootFolder,
    explicitHome,
  } = useSpace();
  const { createRoot, deleteRoot, openLastActiveRoot, openRoot } =
    useSpaceActions();

  useEffect(() => {
    if (autoOpenAttempted.current) return;
    autoOpenAttempted.current = true;

    (async () => {
      if (explicitHome) {
        await loadRootSpaces();
        return;
      }

      const opened = await openLastActiveRoot();
      if (opened) {
        navigate({ to: "/space" });
      }
    })();
  }, [loadRootSpaces, openLastActiveRoot, navigate, explicitHome]);

  // Keyboard shortcut: Cmd+N to create project
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        setCreateDialogOpen(true);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleOpenProject = useCallback(
    async (id: string) => {
      if (await openRoot(id)) {
        navigate({ to: "/space" });
      }
    },
    [openRoot, navigate],
  );

  const handleCreateProject = useCallback(
    async (
      name: string,
      icon: string,
      description: string | undefined,
      path: string,
    ) => {
      try {
        const ws = await createRoot(name, icon, description, path);
        setCreateDialogOpen(false);
        if (await openRoot(ws.id)) {
          navigate({ to: "/space" });
        }
      } catch (err) {
        const errStr = String(err);
        if (errStr.includes("Project already exists")) {
          toast.info(m.home_project_already_exists());
          setCreateDialogOpen(false);
          // Switch to open folder flow
          try {
            const ws = await openRootFolder(path);
            if (await openRoot(ws.id)) {
              navigate({ to: "/space" });
            }
          } catch (openErr) {
            console.error("Failed to open existing project:", openErr);
            toast.error(m.home_open_project_error(), {
              description: getErrorDescription(openErr),
            });
          }
        } else {
          console.error("Failed to create project:", err);
          toast.error(m.toast_error(), {
            description: getErrorDescription(err),
          });
        }
      }
    },
    [createRoot, openRoot, openRootFolder, navigate],
  );

  const handleOpenProjectFolder = useCallback(async () => {
    const selected = await openDialog({ directory: true });
    if (!selected) return;
    try {
      const ws = await openRootFolder(selected);
      if (await openRoot(ws.id)) {
        navigate({ to: "/space" });
      }
    } catch (err) {
      console.error("Failed to open project folder:", err);
      toast.error(m.home_open_project_error(), {
        description: getErrorDescription(err),
      });
    }
  }, [openRootFolder, openRoot, navigate]);

  const [cloningProject, setCloningProject] = useState<{
    name: string;
    path: string;
    phase: string;
    percent: number;
    error?: string;
  } | null>(null);

  const handleCloneProject = useCallback(
    async (url: string, targetPath: string) => {
      setCloneDialogOpen(false);

      const repoName =
        url
          .split("/")
          .pop()
          ?.replace(/\.git$/, "") || "project";
      setCloningProject({
        name: repoName,
        path: targetPath,
        phase: "Starting",
        percent: 0,
      });

      const unlisten = await listen<CloneProgress>(
        "clone:progress",
        (event) => {
          if (event.payload.spacePath !== targetPath) return;
          setCloningProject((prev) =>
            prev
              ? {
                  ...prev,
                  phase: event.payload.phase,
                  percent: event.payload.percent,
                }
              : prev,
          );
        },
      );

      try {
        const ws = await cloneProject(url, targetPath);
        setCloningProject(null);
        registerRootSpace(ws);
        if (await openRoot(ws.id)) {
          navigate({ to: "/space" });
        }
      } catch (err) {
        console.error("project_clone failed:", err);
        const message =
          typeof err === "string" ? err : ((err as Error)?.message ?? "error");
        setCloningProject((prev) =>
          prev
            ? { ...prev, phase: "Failed", percent: 0, error: message }
            : prev,
        );
        toast.error(m.git_clone_failed(), {
          description: getErrorDescription(err),
        });
        window.setTimeout(() => setCloningProject(null), 6000);
      } finally {
        unlisten();
      }
    },
    [openRoot, navigate],
  );

  const handleDeleteProject = useCallback(
    async (id: string, deleteFiles: boolean) => {
      try {
        await deleteRoot(id, deleteFiles);
      } catch (err) {
        console.error("Failed to delete project:", err);
      }
    },
    [deleteRoot],
  );

  const hasProjects = rootSpaces.length > 0 || isLoadingRoots;

  return (
    <div className="flex flex-col h-screen">
      {/* Drag region header */}
      <div data-tauri-drag-region className="h-[44px] shrink-0 w-full" />

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center justify-center px-4">
        {/* Branding */}
        <div className="text-center mb-6">
          <img src="/logo.png" alt="Svode" className="h-12 w-12 mx-auto mb-2" />
          <h1 className="text-2xl font-semibold">{m.home_title()}</h1>
          <p className="text-xs text-muted-foreground mt-1">
            {m.home_version({ version })}
          </p>
        </div>

        {/* Action cards */}
        <div className="flex gap-3 mb-8">
          <Card
            className="flex flex-col justify-between w-40 h-24 p-4 hover:bg-accent transition-colors cursor-pointer"
            onClick={() => setCreateDialogOpen(true)}
          >
            <FolderPlus className="h-5 w-5 text-muted-foreground" />
            <span className="text-sm font-medium">
              {m.home_create_project()}
            </span>
          </Card>
          <Card
            className="flex flex-col justify-between w-40 h-24 p-4 hover:bg-accent transition-colors cursor-pointer"
            onClick={handleOpenProjectFolder}
          >
            <FolderOpen className="h-5 w-5 text-muted-foreground" />
            <span className="text-sm font-medium">{m.home_open_project()}</span>
          </Card>
          <Card
            className="flex flex-col justify-between w-40 h-24 p-4 hover:bg-accent transition-colors cursor-pointer"
            onClick={() => setCloneDialogOpen(true)}
          >
            <FolderGit2 className="h-5 w-5 text-muted-foreground" />
            <span className="text-sm font-medium">
              {m.home_clone_project()}
            </span>
          </Card>
        </div>

        {hasProjects ? (
          <ProjectList
            projects={rootSpaces}
            isLoading={isLoadingRoots}
            onOpenProject={handleOpenProject}
            onDeleteProject={handleDeleteProject}
            cloningProject={cloningProject}
          />
        ) : (
          <EmptyState />
        )}
      </div>

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
    </div>
  );
}
