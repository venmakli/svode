import { useLayoutEffect } from "react";
import type { SpaceGitType, SpaceInfo } from "@/features/space";
import type { ProjectSpaceGitTypeMap } from "../hooks/use-project-space-git-types";
import {
  useSettingsOwnerBlocks,
  type SettingsOwnerReveal,
} from "../hooks/use-settings-owner-blocks";
import { useSpaceStorageSettings } from "../hooks/use-space-storage-settings";
import type { SettingsLeaveGuard } from "../model/settings-destination";
import { ProjectOwnerBlock, SpaceOwnerBlock } from "./project-owner-block";
import {
  StorageInheritedGroup,
  StorageSettingsSection,
  StorageStrategyConfirmDialog,
  storageSummary,
} from "./storage-section";

type RegisterLeaveGuard = (guard: SettingsLeaveGuard) => () => void;

// Storage of the project and of every space on one page. An inline space
// uses the project strategy and only points to it; a space with its own
// repository is a collapsible block whose heading summarizes its strategy.
export function ProjectStorageSection({
  projectPath,
  projectName,
  projectIcon,
  spaces,
  gitTypes,
  reveal,
  registerLeaveGuard,
}: {
  projectPath: string;
  projectName: string;
  projectIcon?: string | null;
  spaces: SpaceInfo[];
  gitTypes: ProjectSpaceGitTypeMap;
  reveal: SettingsOwnerReveal;
  registerLeaveGuard: RegisterLeaveGuard;
}) {
  const blocks = useSettingsOwnerBlocks(reveal);
  // The inline spaces name the project strategy, so the project's storage
  // lifecycle lives with the page.
  const project = useStorageOwner({
    projectPath,
    spacePath: projectPath,
    spaceId: null,
    detailsActive: true,
    registerLeaveGuard,
  });
  const showProject = () => blocks.reveal(projectPath);
  return (
    <>
      <ProjectOwnerBlock
        name={projectName}
        icon={projectIcon}
        headingRef={blocks.headingRef(projectPath)}
      >
        <StorageSettingsSection
          settings={project}
          projectName={projectName}
          onOpenProject={showProject}
        />
      </ProjectOwnerBlock>
      <StorageStrategyConfirmDialog settings={project} />
      {spaces.map((space) => {
        const gitType = gitTypes[space.id];
        const headingRef = blocks.headingRef(space.path);
        if (space.status !== "ready")
          return (
            <SpaceOwnerBlock
              key={space.path}
              space={space}
              gitType={undefined}
              headingRef={headingRef}
            />
          );
        // The block takes its shape once the space's repository type is
        // known; a navigation request waits for it.
        if (gitType === undefined)
          return (
            <SpaceOwnerBlock key={space.path} space={space} gitType={gitType} />
          );
        if (gitType === "inline")
          return (
            <SpaceOwnerBlock
              key={space.path}
              space={space}
              gitType={gitType}
              headingRef={headingRef}
            >
              <StorageInheritedGroup
                projectName={projectName}
                strategy={
                  project.storageConfigLoaded
                    ? project.savedAssetsStrategy
                    : null
                }
                loading={
                  !project.storageConfigLoaded && !project.storageConfigError
                }
                onOpenProject={showProject}
              />
            </SpaceOwnerBlock>
          );
        return (
          <SpaceStorageOwner
            key={space.path}
            projectPath={projectPath}
            projectName={projectName}
            space={space}
            gitType={gitType}
            opened={blocks.opened(space.path)}
            expanded={blocks.expanded(space.path)}
            onExpandedChange={(open) => blocks.setExpanded(space.path, open)}
            headingRef={headingRef}
            registerLeaveGuard={registerLeaveGuard}
            onOpenProject={showProject}
          />
        );
      })}
    </>
  );
}

// One space repository. Its strategy loads with the page for the heading
// summary; the S3 pair, LFS state and diagnostics load when the block is
// first opened and stay while it is collapsed.
function SpaceStorageOwner({
  projectPath,
  projectName,
  space,
  gitType,
  opened,
  expanded,
  onExpandedChange,
  headingRef,
  registerLeaveGuard,
  onOpenProject,
}: {
  projectPath: string;
  projectName: string;
  space: SpaceInfo;
  gitType: SpaceGitType | null;
  opened: boolean;
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
  headingRef: (node: HTMLElement | null) => void;
  registerLeaveGuard: RegisterLeaveGuard;
  onOpenProject: () => void;
}) {
  const settings = useStorageOwner({
    projectPath,
    spacePath: space.path,
    spaceId: space.id,
    detailsActive: opened,
    registerLeaveGuard,
  });
  return (
    <>
      <SpaceOwnerBlock
        space={space}
        gitType={gitType}
        summary={storageSummary(settings)}
        headingRef={headingRef}
        collapsible={{ open: expanded, onOpenChange: onExpandedChange }}
      >
        <StorageSettingsSection
          settings={settings}
          projectName={projectName}
          onOpenProject={onOpenProject}
        />
      </SpaceOwnerBlock>
      <StorageStrategyConfirmDialog settings={settings} />
    </>
  );
}

// One owner's storage lifecycle. An applying strategy or S3 write keeps
// Settings open, even from a collapsed block.
function useStorageOwner({
  projectPath,
  spacePath,
  spaceId,
  detailsActive,
  registerLeaveGuard,
}: {
  projectPath: string;
  spacePath: string;
  spaceId: string | null;
  detailsActive: boolean;
  registerLeaveGuard: RegisterLeaveGuard;
}) {
  const settings = useSpaceStorageSettings({
    open: true,
    detailsActive,
    diagnosticsActive: true,
    spacePath,
    projectPath,
    currentSpaceId: spaceId,
    isRoot: spaceId === null,
  });
  const busy = settings.applyingStrategy || settings.s3.pending;
  useLayoutEffect(
    () => registerLeaveGuard(() => !busy),
    [registerLeaveGuard, busy],
  );
  return settings;
}
