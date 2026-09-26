import { useCallback, useMemo } from "react";
import { toast } from "sonner";

import * as m from "@/paraglide/messages.js";
import { getNativeErrorMessage } from "@/platform/native/errors";

import { projectExternalOpenTarget } from "../api/project-target";
import type { ExternalApp } from "../model/types";
import { ExternalOpenButton } from "./external-open-button";

/** External open of the active project root, with failures reported as a toast. */
export function ProjectExternalOpenButton({
  projectPath,
}: {
  projectPath: string;
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

  return (
    <ExternalOpenButton
      key={projectPath}
      target={target}
      onError={handleError}
    />
  );
}
