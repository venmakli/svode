import { ChevronRight, Plus } from "lucide-react";
import type { ReactNode } from "react";
import * as m from "@/paraglide/messages.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RepositoryAccessBadge } from "@/features/git";
import type { SpaceGitType, SpaceInfo, SpaceStatus } from "@/features/space";
import type { ProjectSpaceGitTypeMap } from "../hooks/use-project-space-git-types";

export type ProjectSpaceDetailSection = "general" | "git" | "storage";

interface ProjectSpacesSectionProps {
  spaces: SpaceInfo[];
  gitTypes: ProjectSpaceGitTypeMap;
  onAddSpace: () => void;
  onOpenSpaceDetail: (
    spaceId: string,
    section: ProjectSpaceDetailSection,
  ) => void;
}

interface ProjectSpacePolicyListProps {
  projectPath: string;
  spaces: SpaceInfo[];
  gitTypes: ProjectSpaceGitTypeMap;
  section: Exclude<ProjectSpaceDetailSection, "general">;
  onOpenSpaceDetail: (
    spaceId: string,
    section: ProjectSpaceDetailSection,
  ) => void;
}

export function ProjectSpacesSection({
  spaces,
  gitTypes,
  onAddSpace,
  onOpenSpaceDetail,
}: ProjectSpacesSectionProps) {
  return (
    <section className="flex w-full min-w-0 max-w-2xl flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium">{m.settings_spaces()}</h2>
          <Button type="button" size="sm" onClick={onAddSpace}>
            <Plus data-icon="inline-start" />
            {m.sidebar_add_space()}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          {m.settings_spaces_description()}
        </p>
      </div>

      {spaces.length === 0 ? (
        <p className="rounded-md border p-3 text-sm text-muted-foreground">
          {m.settings_spaces_empty()}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {spaces.map((space) => (
            <SpaceSummaryRow
              key={space.id}
              space={space}
              gitType={gitTypes[space.id]}
              disabled={space.status !== "ready"}
              actionLabel={m.settings_general()}
              onClick={() => onOpenSpaceDetail(space.id, "general")}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function ProjectSpacePolicyList({
  projectPath,
  spaces,
  gitTypes,
  section,
  onOpenSpaceDetail,
}: ProjectSpacePolicyListProps) {
  if (spaces.length === 0) return null;

  const label = section === "git" ? m.git_section() : m.storage_section();

  return (
    <section className="flex w-full min-w-0 max-w-2xl flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">
          {m.settings_project_policy_spaces_title()}
        </h2>
        <p className="text-xs text-muted-foreground">
          {m.settings_project_policy_spaces_description()}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        {spaces.map((space) => {
          const gitType = gitTypes[space.id];
          const canEditRepo =
            gitType === "independent" || gitType === "submodule";
          const actionLabel = canEditRepo
            ? m.settings_space_policy_edit({ section: label })
            : m.settings_space_policy_view({ section: label });
          return (
            <SpaceSummaryRow
              key={space.id}
              space={space}
              gitType={gitType}
              disabled={space.status !== "ready"}
              actionLabel={actionLabel}
              compactAction
              onClick={() => onOpenSpaceDetail(space.id, section)}
              repositoryAccess={
                section === "git" && space.status === "ready" ? (
                  <RepositoryAccessBadge
                    ownerKind={gitType ?? "independent"}
                    repositoryPath={
                      gitType === "inline" ? projectPath : space.path
                    }
                  />
                ) : null
              }
            />
          );
        })}
      </div>
    </section>
  );
}

function SpaceSummaryRow({
  space,
  gitType,
  disabled,
  actionLabel,
  compactAction = false,
  onClick,
  repositoryAccess,
}: {
  space: SpaceInfo;
  gitType?: SpaceGitType | null;
  disabled?: boolean;
  actionLabel?: string;
  compactAction?: boolean;
  onClick?: () => void;
  repositoryAccess?: ReactNode;
}) {
  const gitTypeLabel = spaceGitTypeLabel(gitType);
  const statusLabel = spaceStatusLabel(space.status);
  const content = (
    <div className="flex min-w-0 items-start gap-2" data-space-row-content>
      <span className="shrink-0 text-base leading-none">{space.icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center" data-space-row-identity>
          <span
            className="min-w-0 break-words text-sm font-medium"
            title={space.name}
          >
            {space.name}
          </span>
        </div>
        <p
          className="truncate text-xs text-muted-foreground"
          title={space.path}
        >
          {space.path}
        </p>
        {(statusLabel || gitTypeLabel || repositoryAccess) && (
          <div
            className="mt-1 flex min-w-0 flex-wrap items-center gap-2"
            data-space-row-metadata
          >
            {statusLabel && <Badge variant="outline">{statusLabel}</Badge>}
            {gitTypeLabel && <Badge variant="secondary">{gitTypeLabel}</Badge>}
            {repositoryAccess && (
              <span className="flex min-w-0" data-space-row-repository-access>
                {repositoryAccess}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className="grid w-full min-w-0 grid-cols-1 gap-3 rounded-md border p-3 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
        aria-label={
          actionLabel
            ? `${space.name}, ${space.path}: ${actionLabel}`
            : `${space.name}, ${space.path}`
        }
        data-space-summary-row
        disabled={disabled}
        onClick={onClick}
      >
        {content}
        {actionLabel && (
          <span
            className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-medium text-muted-foreground sm:justify-self-end"
            data-space-row-action
          >
            {!compactAction && actionLabel}
            <ChevronRight className="size-3" />
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      {content}
    </div>
  );
}

function spaceGitTypeLabel(gitType: SpaceGitType | null | undefined) {
  if (gitType === undefined) return null;
  if (gitType === null) return m.settings_space_git_type_unknown();

  switch (gitType) {
    case "inline":
      return m.space_type_inline();
    case "independent":
      return m.space_type_independent();
    case "submodule":
      return m.space_type_submodule();
  }
}

function spaceStatusLabel(status: SpaceStatus) {
  switch (status) {
    case "ready":
      return null;
    case "missing":
      return m.settings_space_status_missing();
    case "broken":
      return m.settings_space_status_broken();
  }
}
