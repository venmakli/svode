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
  const spaceGroups = useRef(new Map<string, VariableCatalogGroupHandle>());
  const sharedCallout = useRef<HTMLDivElement>(null);
  // A cause in shared settings blocks every owner; the project block shows it.
  const [sharedShown, setSharedShown] = useState(false);
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
  const retrySpaces = useCallback(() => {
    for (const group of spaceGroups.current.values()) group.retry();
  }, []);
  const showSharedCause = useCallback(() => {
    sharedCallout.current?.scrollIntoView({ block: "nearest" });
    sharedCallout.current?.focus();
  }, []);
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
          sharedCalloutRef={sharedCallout}
          onSharedProblem={setSharedShown}
          onSharedRetry={retrySpaces}
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
              ref={(group) => {
                if (group) spaceGroups.current.set(space.id, group);
                else spaceGroups.current.delete(space.id);
              }}
              projectPath={projectPath}
              spaceId={space.id}
              projectName={projectName}
              registerLeaveGuard={registerLeaveGuard}
              locked={locked(`space:${space.id}`)}
              onEditorChange={handleEditorChange}
              onEditInProject={(entry) =>
                project.current?.edit(entry.name, entry.mode)
              }
              sharedCauseAbove={sharedShown}
              onShowSharedCause={showSharedCause}
            />
          ) : null}
        </SpaceOwnerBlock>
      ))}
    </>
  );
}
