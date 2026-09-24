import type { ReactNode } from "react";
import * as m from "@/paraglide/messages.js";
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
import type { SpaceInfo } from "@/features/space";
import type { ProjectSpaceGitTypeMap } from "../hooks/use-project-space-git-types";
import {
  useSettingsOwnerBlocks,
  type SettingsOwnerReveal,
} from "../hooks/use-settings-owner-blocks";
import { useSpaceSettingsGit } from "../hooks/use-space-settings-git";
import { useSpaceSettingsIdentity } from "../hooks/use-space-settings-identity";
import { ProjectOwnerBlock, SpaceOwnerBlock } from "./project-owner-block";
import { SettingsGroup, SettingsItem } from "./settings-layout";
import { SpaceGitSection, SpaceGitSummary } from "./space-git-section";

// Git of the project and of every space on one page. An inline space is part
// of the project repository and only points to it; a space with its own
// repository is a collapsible block whose heading summarizes access and
// remote.
export function ProjectGitSection({
  projectPath,
  projectName,
  projectIcon,
  spaces,
  gitTypes,
  reveal,
}: {
  projectPath: string;
  projectName: string;
  projectIcon?: string | null;
  spaces: SpaceInfo[];
  gitTypes: ProjectSpaceGitTypeMap;
  reveal: SettingsOwnerReveal;
}) {
  const blocks = useSettingsOwnerBlocks(reveal);
  return (
    <>
      <GitOwner
        projectPath={projectPath}
        projectName={projectName}
        spacePath={projectPath}
        isRoot
        spaces={spaces}
        open
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
              <SettingsGroup>
                <SettingsItem
                  title={m.settings_git_inline_title({ name: projectName })}
                  description={m.settings_git_inline_description()}
                  actions={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => blocks.reveal(projectPath)}
                    >
                      {m.settings_git_inline_open_project()}
                    </Button>
                  }
                />
              </SettingsGroup>
            </SpaceOwnerBlock>
          );
        return (
          <GitOwner
            key={space.path}
            projectPath={projectPath}
            projectName={projectName}
            spacePath={space.path}
            isRoot={false}
            spaces={spaces}
            open={blocks.opened(space.path)}
            block={(content, summary) => (
              <SpaceOwnerBlock
                space={space}
                gitType={gitType}
                summary={summary}
                headingRef={headingRef}
                collapsible={{
                  open: blocks.expanded(space.path),
                  onOpenChange: (open) => blocks.setExpanded(space.path, open),
                }}
              >
                {content}
              </SpaceOwnerBlock>
            )}
          />
        );
      })}
    </>
  );
}

// One repository's Git and identity lifecycle. Git loads with the page for
// the block summary; the identity loads when the block is first opened. The
// block chrome is supplied by the page so the lifecycle outlives a collapsed
// block.
function GitOwner({
  projectPath,
  projectName,
  spacePath,
  isRoot,
  spaces,
  open,
  block,
}: {
  projectPath: string;
  projectName: string;
  spacePath: string;
  isRoot: boolean;
  spaces: SpaceInfo[];
  open: boolean;
  block: (content: ReactNode, summary: ReactNode) => ReactNode;
}) {
  const git = useSpaceSettingsGit({
    open: true,
    spacePath,
    activeRootPath: projectPath,
    isRoot,
    spaces,
  });
  const identity = useSpaceSettingsIdentity({ open, spacePath, isRoot });
  return (
    <>
      {block(
        <SpaceGitSection
          spacePath={spacePath}
          isRoot={isRoot}
          projectName={projectName}
          git={git}
          identity={identity}
        />,
        <SpaceGitSummary repositoryPath={spacePath} git={git} />,
      )}
      <AlertDialog
        open={git.pendingRemote !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) git.cancelPendingRemote();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.git_remote_confirm_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.git_remote_confirm_description({
                url: git.pendingRemote ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={git.cancelPendingRemote}>
              {m.project_cancel()}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => void git.confirmPendingRemote()}>
              {m.git_remote_confirm_action()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
