import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import * as m from "@/paraglide/messages.js";
import { ProjectCard } from "./project-card";
import type { SpaceInfo } from "@/features/space";

interface CloningProject {
  name: string;
  path: string;
  phase: string;
  percent: number;
  error?: string;
}

interface ProjectListProps {
  projects: SpaceInfo[];
  isLoading: boolean;
  onOpenProject: (id: string) => void;
  onDeleteProject: (id: string, deleteFiles: boolean) => void;
  cloningProject?: CloningProject | null;
}

export function ProjectList({
  projects,
  isLoading,
  onOpenProject,
  onDeleteProject,
  cloningProject,
}: ProjectListProps) {
  if (isLoading) {
    return (
      <div className="w-full max-w-md mx-auto space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-2.5">
            <Skeleton className="h-8 w-8 rounded" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Sort by lastOpened (newest first), projects without lastOpened go to end
  const sorted = [...projects].sort((a, b) => {
    if (!a.lastOpened && !b.lastOpened) return 0;
    if (!a.lastOpened) return 1;
    if (!b.lastOpened) return -1;
    return new Date(b.lastOpened).getTime() - new Date(a.lastOpened).getTime();
  });

  return (
    <ScrollArea className="w-full max-w-md mx-auto max-h-[400px]">
      <div className="space-y-0.5">
        {cloningProject && (
          <div className="flex items-center gap-3 rounded-md px-3 py-2.5 opacity-70">
            <span className="text-xl shrink-0">{"\u{1F4E6}"}</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{cloningProject.name}</p>
              {cloningProject.error ? (
                <p className="text-xs text-destructive truncate">{cloningProject.error}</p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    {m.home_cloning()} {cloningProject.percent}%
                  </p>
                  <Progress value={cloningProject.percent} className="h-1 mt-1" />
                </>
              )}
            </div>
          </div>
        )}
        {sorted.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            onClick={() => onOpenProject(project.id)}
            onDelete={(deleteFiles) => onDeleteProject(project.id, deleteFiles)}
          />
        ))}
      </div>
    </ScrollArea>
  );
}
