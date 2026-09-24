import { useCallback, useRef, useState } from "react";
import * as m from "@/paraglide/messages.js";
import { Badge } from "@/components/ui/badge";
import type { SpaceInfo } from "@/features/space";
import type { ProjectSpaceGitTypeMap } from "../hooks/use-project-space-git-types";
import type { SettingsLeaveGuard } from "../model/settings-destination";
import { spaceGitTypeLabel, spaceStatusLabel } from "./owner-labels";
import { SettingsOwnerBlock } from "./settings-layout";
import {
  VariableCatalogGroup,
  type VariableCatalogGroupHandle,
} from "./variable-catalog-group";

type RegisterLeaveGuard = (guard: SettingsLeaveGuard) => () => void;

const FOLDER_ICON = "\u{1F4C1}";

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
  registerLeaveGuard,
}: {
  projectPath: string;
  projectName: string;
  projectIcon?: string | null;
  spaces: SpaceInfo[];
  gitTypes: ProjectSpaceGitTypeMap;
  registerLeaveGuard: RegisterLeaveGuard;
}) {
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
    <div className="flex w-full max-w-3xl min-w-0 flex-col gap-8">
      <p className="text-sm text-muted-foreground">
        {m.variables_project_description()}
      </p>
      <SettingsOwnerBlock
        icon={projectIcon || FOLDER_ICON}
        title={projectName}
        badges={<Badge variant="secondary">{m.settings_project_label()}</Badge>}
      >
        <VariableCatalogGroup
          ref={project}
          projectPath={projectPath}
          projectName={projectName}
          registerLeaveGuard={registerLeaveGuard}
          locked={locked("project")}
          onEditorChange={handleEditorChange}
        />
      </SettingsOwnerBlock>
      {spaces.map((space) => {
        const ready = space.status === "ready";
        const type = ready ? gitTypes[space.id] : undefined;
        const status = spaceStatusLabel(space.status);
        return (
          <SettingsOwnerBlock
            key={space.id}
            icon={space.icon || FOLDER_ICON}
            title={space.name}
            badges={
              <>
                {type ? (
                  <Badge variant="secondary">{spaceGitTypeLabel(type)}</Badge>
                ) : null}
                {status ? <Badge variant="outline">{status}</Badge> : null}
              </>
            }
          >
            {ready ? (
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
          </SettingsOwnerBlock>
        );
      })}
    </div>
  );
}
