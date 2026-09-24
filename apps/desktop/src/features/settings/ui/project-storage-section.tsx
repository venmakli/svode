import { useLayoutEffect, type ReactNode } from "react";
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
  StorageSettingsSection,
  StorageStrategyConfirmDialog,
} from "./storage-section";

type RegisterLeaveGuard = (guard: SettingsLeaveGuard) => () => void;

// Storage of the project and of every space on one page. A space block loads
// its forms when first opened and keeps them while collapsed.
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
  const showProject = () => blocks.reveal(projectPath);
  return (
    <>
      <StorageOwner
        projectPath={projectPath}
        projectName={projectName}
        spacePath={projectPath}
        spaceId={null}
        gitType={null}
        spaces={spaces}
        open
        registerLeaveGuard={registerLeaveGuard}
        onOpenProject={showProject}
        block={(content) => (
          <ProjectOwnerBlock
            name={projectName}
            icon={projectIcon}
            headingRef={blocks.headingRef(projectPath)}
          >
            {content}
          </ProjectOwnerBlock>
        )}
      />
      {spaces.map((space) =>
        space.status === "ready" ? (
          <StorageOwner
            key={space.path}
            projectPath={projectPath}
            projectName={projectName}
            spacePath={space.path}
            spaceId={space.id}
            gitType={gitTypes[space.id] ?? null}
            spaces={spaces}
            open={blocks.opened(space.path)}
            registerLeaveGuard={registerLeaveGuard}
            onOpenProject={showProject}
            block={(content) => (
              <SpaceOwnerBlock
                space={space}
                gitType={gitTypes[space.id]}
                headingRef={blocks.headingRef(space.path)}
                collapsible={{
                  open: blocks.expanded(space.path),
                  onOpenChange: (open) => blocks.setExpanded(space.path, open),
                }}
              >
                {content}
              </SpaceOwnerBlock>
            )}
          />
        ) : (
          <SpaceOwnerBlock
            key={space.path}
            space={space}
            gitType={undefined}
            headingRef={blocks.headingRef(space.path)}
          />
        ),
      )}
    </>
  );
}

// One owner's storage lifecycle; the block chrome is supplied by the page so
// an applying strategy or S3 write survives a collapsed block and still
// blocks leaving Settings.
function StorageOwner({
  projectPath,
  projectName,
  spacePath,
  spaceId,
  gitType,
  spaces,
  open,
  registerLeaveGuard,
  onOpenProject,
  block,
}: {
  projectPath: string;
  projectName: string;
  spacePath: string;
  spaceId: string | null;
  gitType: SpaceGitType | null;
  spaces: SpaceInfo[];
  open: boolean;
  registerLeaveGuard: RegisterLeaveGuard;
  onOpenProject: () => void;
  block: (content: ReactNode) => ReactNode;
}) {
  const settings = useSpaceStorageSettings({
    open,
    diagnosticsActive: true,
    spacePath,
    projectPath,
    currentSpaceId: spaceId,
    isRoot: spaceId === null,
    spaces,
  });
  const busy = settings.applyingStrategy || settings.s3.pending;
  useLayoutEffect(
    () => registerLeaveGuard(() => !busy),
    [registerLeaveGuard, busy],
  );
  return (
    <>
      {block(
        <StorageSettingsSection
          gitType={gitType}
          activeRootName={projectName}
          settings={settings}
          onOpenRoot={onOpenProject}
        />,
      )}
      <StorageStrategyConfirmDialog settings={settings} />
    </>
  );
}
