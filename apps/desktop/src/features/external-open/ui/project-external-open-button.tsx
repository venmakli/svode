import { useCallback, useMemo } from "react";
import { toast } from "sonner";

import * as m from "@/paraglide/messages.js";
import { getNativeErrorMessage } from "@/platform/native/errors";

import { projectExternalOpenTarget } from "../api/project-target";
import { useExternalOpenGroup } from "../hooks/use-external-open-group";
import type { ExternalApp, OpenWithGroup } from "../model/types";
import { OpenWithControl } from "./open-with-control";

/**
 * External open of the active project root, with failures reported as a
 * toast. An object group of the open screen leads the control and gives its
 * primary action; the project applications follow it.
 */
export function ProjectExternalOpenButton({
  projectPath,
  objectGroup,
}: {
  projectPath: string;
  objectGroup?: OpenWithGroup;
}) {
  return (
    <ProjectOpenWith
      key={projectPath}
      projectPath={projectPath}
      objectGroup={objectGroup}
    />
  );
}

function ProjectOpenWith({
  projectPath,
  objectGroup,
}: {
  projectPath: string;
  objectGroup?: OpenWithGroup;
}) {
  const target = useMemo(
    () => projectExternalOpenTarget(projectPath),
    [projectPath],
  );
  const handleError = useCallback((error: unknown, app: ExternalApp | null) => {
    console.error("Failed to open project externally:", error);
    toast.error(
      app
        ? m.external_open_project_error({ name: app.label })
        : m.external_open_project_error_default(),
      { description: getNativeErrorMessage(error) },
    );
  }, []);
  const projectGroup = useExternalOpenGroup({ target, onError: handleError });

  return (
    <OpenWithControl
      groups={objectGroup ? [objectGroup, projectGroup] : [projectGroup]}
    />
  );
}
