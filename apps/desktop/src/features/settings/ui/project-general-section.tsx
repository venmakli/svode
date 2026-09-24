import { useId, useState } from "react";
import { Plus } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  CreateSpaceDialog,
  type SpaceGitType,
  type SpaceInfo,
} from "@/features/space";
import type { ProjectSpaceGitTypeMap } from "../hooks/use-project-space-git-types";
import {
  useSettingsOwnerBlocks,
  type SettingsOwnerReveal,
} from "../hooks/use-settings-owner-blocks";
import { useSpaceSettingsConfigActions } from "../hooks/use-space-settings-config-actions";
import { useSpaceSettingsGeneral } from "../hooks/use-space-settings-general";
import { useSpaceSettingsHealth } from "../hooks/use-space-settings-health";
import { ProjectOwnerBlock, SpaceOwnerBlock } from "./project-owner-block";
import { SpaceGeneralSection } from "./space-general-section";
import { SpaceHealthSection } from "./space-health-section";

// "General" of the project: the project block, then every space with its own
// details. Spaces are added here.
export function ProjectGeneralSection({
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
  const health = useSpaceSettingsHealth({
    open: true,
    active: true,
    activeRootPath: projectPath,
    isRoot: true,
  });
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false);
  const spacesTitleId = useId();
  const addSpace = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => setCreateSpaceOpen(true)}
    >
      <Plus data-icon="inline-start" />
      {m.sidebar_add_space()}
    </Button>
  );
  return (
    <>
      <ProjectOwnerBlock
        name={projectName}
        icon={projectIcon}
        headingRef={blocks.headingRef(projectPath)}
      >
        <OwnerDetails projectPath={projectPath} spacePath={projectPath} />
        <SpaceHealthSection
          brokenLinksCount={health.brokenLinksCount}
          loading={health.linkHealthLoading}
          failed={health.linkHealthFailed}
          onRefresh={health.loadLinkHealth}
        />
      </ProjectOwnerBlock>
      <section
        aria-labelledby={spacesTitleId}
        className="flex min-w-0 flex-col gap-4"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          <h3
            id={spacesTitleId}
            className="min-w-0 text-base font-semibold wrap-break-word"
          >
            {m.settings_spaces()}
          </h3>
          {spaces.length > 0 ? <div className="ml-auto">{addSpace}</div> : null}
        </div>
        {spaces.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-8">
            {spaces.map((space) => (
              <SpaceOwnerBlock
                key={space.path}
                space={space}
                gitType={gitTypes[space.id]}
                headingRef={blocks.headingRef(space.path)}
              >
                {space.status === "ready" ? (
                  <OwnerDetails
                    projectPath={projectPath}
                    spacePath={space.path}
                    space={{ gitType: gitTypes[space.id] }}
                  />
                ) : (
                  <SpaceGeneralSection path={space.path} />
                )}
              </SpaceOwnerBlock>
            ))}
          </div>
        ) : (
          <Card className="gap-0 py-0">
            <Empty className="p-6">
              <EmptyHeader>
                <EmptyTitle>{m.settings_spaces_empty()}</EmptyTitle>
              </EmptyHeader>
              <EmptyContent>{addSpace}</EmptyContent>
            </Empty>
          </Card>
        )}
      </section>
      <CreateSpaceDialog
        open={createSpaceOpen}
        onOpenChange={setCreateSpaceOpen}
      />
    </>
  );
}

// One owner's details with their own load and save lifecycle.
function OwnerDetails({
  projectPath,
  spacePath,
  space,
}: {
  projectPath: string;
  spacePath: string;
  space?: { gitType: SpaceGitType | null | undefined };
}) {
  const { saveConfig } = useSpaceSettingsConfigActions({
    spacePath,
    projectPath,
  });
  const general = useSpaceSettingsGeneral({
    open: true,
    spacePath,
    saveConfig,
  });
  return (
    <SpaceGeneralSection
      path={spacePath}
      space={space}
      editor={{
        status: general.status,
        onRetry: general.retryGeneralConfig,
        icon: general.icon,
        name: general.name,
        description: general.description,
        onIconChange: general.handleIconChange,
        onNameChange: general.setName,
        onNameBlur: general.handleNameBlur,
        onDescriptionChange: general.setDescription,
        onDescriptionBlur: general.handleDescriptionBlur,
      }}
    />
  );
}
