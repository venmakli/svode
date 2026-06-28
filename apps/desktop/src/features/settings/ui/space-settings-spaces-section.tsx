import { ChevronRight, Plus } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
    <section className="flex max-w-2xl flex-col gap-4">
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
  spaces,
  gitTypes,
  section,
  onOpenSpaceDetail,
}: ProjectSpacePolicyListProps) {
  if (spaces.length === 0) return null;

  const label = section === "git" ? m.git_section() : m.storage_section();

  return (
    <section className="flex max-w-2xl flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">
          {m.settings_project_policy_spaces_title()}
        </h2>
        <p className="text-sm text-muted-foreground">
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
              onClick={() => onOpenSpaceDetail(space.id, section)}
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
  onClick,
}: {
  space: SpaceInfo;
  gitType?: SpaceGitType | null;
  disabled?: boolean;
  actionLabel?: string;
  onClick?: () => void;
}) {
  const gitTypeLabel = spaceGitTypeLabel(gitType);
  const statusLabel = spaceStatusLabel(space.status);
  const content = (
    <>
      <div className="flex min-w-0 items-start gap-2">
        <span className="text-base leading-none">{space.icon}</span>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{space.name}</span>
            {statusLabel && <Badge variant="outline">{statusLabel}</Badge>}
            {gitTypeLabel && <Badge variant="secondary">{gitTypeLabel}</Badge>}
          </div>
          <p className="truncate text-xs text-muted-foreground">{space.path}</p>
        </div>
      </div>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className="flex w-full flex-col gap-3 rounded-md border p-3 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 sm:flex-row sm:items-start sm:justify-between"
        aria-label={actionLabel ? `${space.name}: ${actionLabel}` : space.name}
        disabled={disabled}
        onClick={onClick}
      >
        {content}
        {actionLabel && (
          <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
            {actionLabel}
            <ChevronRight className="size-3" />
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-start sm:justify-between">
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
