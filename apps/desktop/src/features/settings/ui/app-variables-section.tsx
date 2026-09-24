import { useCallback, useRef, useState } from "react";
import * as m from "@/paraglide/messages.js";
import type { SpaceInfo } from "@/features/space";
import type { ProjectSpaceGitTypeMap } from "../hooks/use-project-space-git-types";
import {
  useSettingsOwnerBlocks,
  type SettingsOwnerReveal,
} from "../hooks/use-settings-owner-blocks";
import type { SettingsLeaveGuard } from "../model/settings-destination";
import { ProjectOwnerBlock, SpaceOwnerBlock } from "./project-owner-block";
import {
  VariableCatalogGroup,
  type VariableCatalogGroupHandle,
} from "./variable-catalog-group";

type RegisterLeaveGuard = (guard: SettingsLeaveGuard) => () => void;

export function GlobalVariablesSection({
  registerLeaveGuard,
}: {
  registerLeaveGuard?: RegisterLeaveGuard;
}) {
  return (
    <VariableCatalogGroup
      description={m.variables_global_description()}
      registerLeaveGuard={registerLeaveGuard}
    />
  );
}

// Variables of the project and of every space on one page: one block per
// owner, at most one open editor on the page.
export function ProjectVariablesSection({
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
  const project = useRef<VariableCatalogGroupHandle>(null);
  const [editorOwner, setEditorOwner] = useState<string | null>(null);
  const handleEditorChange = useCallback(
    (owner: string, open: boolean) =>
      setEditorOwner((current) =>
        open ? owner : current === owner ? null : current,
      ),
    [],
  );
  const locked = (owner: string) =>
    editorOwner !== null && editorOwner !== owner;
  return (
    <>
      <p className="text-sm text-muted-foreground">
        {m.variables_project_description()}
      </p>
      <ProjectOwnerBlock
        name={projectName}
        icon={projectIcon}
        headingRef={blocks.headingRef(projectPath)}
      >
        <VariableCatalogGroup
          ref={project}
          projectPath={projectPath}
          projectName={projectName}
          registerLeaveGuard={registerLeaveGuard}
          locked={locked("project")}
          onEditorChange={handleEditorChange}
        />
      </ProjectOwnerBlock>
      {spaces.map((space) => (
        <SpaceOwnerBlock
          key={space.id}
          space={space}
          gitType={gitTypes[space.id]}
          headingRef={blocks.headingRef(space.path)}
        >
          {space.status === "ready" ? (
            <VariableCatalogGroup
              projectPath={projectPath}
              spaceId={space.id}
              projectName={projectName}
              registerLeaveGuard={registerLeaveGuard}
              locked={locked(`space:${space.id}`)}
              onEditorChange={handleEditorChange}
              onEditInProject={(entry) =>
                project.current?.edit(entry.name, entry.mode)
              }
            />
          ) : null}
        </SpaceOwnerBlock>
      ))}
    </>
  );
}
