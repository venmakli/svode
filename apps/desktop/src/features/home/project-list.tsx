import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ProjectCard } from "./project-card";
import type { Project } from "@/types/workspace";

interface ProjectListProps {
  projects: Project[];
  isLoading: boolean;
  onOpenProject: (id: string) => void;
  onDeleteProject: (id: string) => void;
}

export function ProjectList({
  projects,
  isLoading,
  onOpenProject,
  onDeleteProject,
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
        {sorted.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            onClick={() => onOpenProject(project.id)}
            onDelete={() => onDeleteProject(project.id)}
          />
        ))}
      </div>
    </ScrollArea>
  );
}
