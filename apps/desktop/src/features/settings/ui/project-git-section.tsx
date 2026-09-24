import { useCallback, useRef, type ReactNode, type RefObject } from "react";
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
import type { SpaceInfo } from "@/features/space";
import type { ProjectSpaceGitTypeMap } from "../hooks/use-project-space-git-types";
import {
  useSettingsOwnerBlocks,
  type SettingsOwnerReveal,
} from "../hooks/use-settings-owner-blocks";
import { useSpaceSettingsGit } from "../hooks/use-space-settings-git";
import { useSpaceSettingsIdentity } from "../hooks/use-space-settings-identity";
import { ProjectOwnerBlock, SpaceOwnerBlock } from "./project-owner-block";
import { SpaceGitSection } from "./space-git-section";

// Git of the project and of every space on one page. A space block loads its
// forms when first opened and keeps them while collapsed.
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
  const projectRemote = useRef<HTMLInputElement>(null);
  const editProjectRemote = useCallback(
    () => projectRemote.current?.focus(),
    [],
  );
  return (
    <>
      <GitOwner
        projectPath={projectPath}
        projectName={projectName}
        spacePath={projectPath}
        ownerName={projectName}
        isRoot
        spaces={spaces}
        open
        remoteRef={projectRemote}
        onEditProjectRemote={editProjectRemote}
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
          <GitOwner
            key={space.path}
            projectPath={projectPath}
            projectName={projectName}
            spacePath={space.path}
            ownerName={space.name}
            isRoot={false}
            spaces={spaces}
            open={blocks.opened(space.path)}
            onEditProjectRemote={editProjectRemote}
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

// One owner's Git and identity lifecycle; the block chrome is supplied by the
// page so the lifecycle outlives a collapsed block.
function GitOwner({
  projectPath,
  projectName,
  spacePath,
  ownerName,
  isRoot,
  spaces,
  open,
  remoteRef,
  onEditProjectRemote,
  block,
}: {
  projectPath: string;
  projectName: string;
  spacePath: string;
  ownerName: string;
  isRoot: boolean;
  spaces: SpaceInfo[];
  open: boolean;
  remoteRef?: RefObject<HTMLInputElement | null>;
  onEditProjectRemote: () => void;
  block: (content: ReactNode) => ReactNode;
}) {
  const git = useSpaceSettingsGit({
    open,
    spacePath,
    activeRootPath: projectPath,
    isRoot,
    spaces,
  });
  const identity = useSpaceSettingsIdentity({ open, spacePath, isRoot });
  const inline = git.gitType === "inline";
  return (
    <>
      {block(
        <SpaceGitSection
          gitType={git.gitType}
          repositoryAccessOwnerKind={
            isRoot ? "project" : (git.gitType ?? "independent")
          }
          repositoryPath={inline ? projectPath : spacePath}
          repositoryDisplayPath={inline ? projectPath : spacePath}
          repositoryOwnerName={inline ? projectName : ownerName}
          activeRootName={projectName}
          scopeName={ownerName}
          isRoot={isRoot}
          submoduleUrl={git.submoduleUrl}
          remoteUrl={git.remoteUrl}
          branch={git.branch}
          autoSync={git.autoSync}
          autoCommitStructural={git.autoCommitStructural}
          autoCommitSystem={git.autoCommitSystem}
          repoIdentity={identity.repoIdentity}
          identityName={identity.identityName}
          identityEmail={identity.identityEmail}
          identityFormError={identity.identityFormError}
          savingIdentity={identity.savingIdentity}
          canResetIdentity={identity.canResetIdentity}
          identityEditing={identity.identityEditing}
          remoteUpdateResult={git.remoteUpdateResult}
          fanoutEnabled={identity.fanoutEnabled}
          fanoutPreview={identity.fanoutPreview}
          fanoutSelected={identity.fanoutSelected}
          onRemoteChange={git.setRemoteUrl}
          onRemoteBlur={git.handleRemoteBlur}
          onAutoSyncChange={git.handleAutoSyncChange}
          onAutoCommitStructuralChange={git.handleAutoCommitStructuralChange}
          onAutoCommitSystemChange={git.handleAutoCommitSystemChange}
          onIdentityNameChange={identity.setIdentityName}
          onIdentityEmailChange={identity.setIdentityEmail}
          onStartIdentityEdit={identity.handleStartIdentityEdit}
          onCancelIdentityEdit={identity.handleCancelIdentityEdit}
          onSaveIdentity={identity.handleSaveIdentity}
          onResetIdentity={identity.handleResetIdentity}
          onFanoutEnabledChange={identity.setFanoutEnabled}
          onFanoutSelectedChange={identity.setFanoutSelected}
          remoteRef={remoteRef}
          onEditProjectRemote={onEditProjectRemote}
        />,
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
