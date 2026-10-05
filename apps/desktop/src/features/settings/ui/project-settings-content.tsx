import { useCallback, useLayoutEffect, useRef } from "react";
import { useSpace } from "@/features/space";
import { useProjectSpaceGitTypes } from "../hooks/use-project-space-git-types";
import type {
  ProjectSettingsSection,
  SettingsLeaveGuard,
} from "../model/settings-destination";
import { ProjectVariablesSection } from "./app-variables-section";
import { ProjectGeneralSection } from "./project-general-section";
import { ProjectGitSection } from "./project-git-section";
import { ProjectStorageSection } from "./project-storage-section";

// One project section page: the project block, then a block per space. The
// destination's space is the owner whose block is shown; the project opens
// the page at its top.
export function ProjectSettingsContent({
  destination,
  registerLeaveGuard,
}: {
  destination: { section: ProjectSettingsSection; spacePath: string };
  registerLeaveGuard: (guard: SettingsLeaveGuard) => () => void;
}) {
  const open = true;
  const { activeRootPath, activeRootName, activeRootIcon, spaces } =
    useSpace();
  const projectPath = activeRootPath!;
  const projectName = activeRootName || "Project";
  const { section, spacePath } = destination;
  const reveal = {
    owner: spacePath === projectPath ? null : spacePath,
    request: destination,
  };

  const gitTypes = useProjectSpaceGitTypes({
    open,
    active: true,
    projectPath,
    spaces,
  });
  // Every owner part with its own pending writes (Variables catalogs, Storage
  // apply and S3) registers here; leaving is allowed only when none is busy.
  const sectionGuards = useRef(new Set<SettingsLeaveGuard>());
  const registerSectionGuard = useCallback((guard: SettingsLeaveGuard) => {
    sectionGuards.current.add(guard);
    return () => {
      sectionGuards.current.delete(guard);
    };
  }, []);

  useLayoutEffect(
    () =>
      registerLeaveGuard(() => {
        for (const guard of sectionGuards.current) if (!guard()) return false;
        return true;
      }),
    [registerLeaveGuard],
  );

  const owners = {
    projectPath,
    projectName,
    projectIcon: activeRootIcon,
    spaces,
    gitTypes,
    reveal,
  };

  return (
    <>
      {section === "general" && <ProjectGeneralSection {...owners} />}

      {section === "variables" && (
        <ProjectVariablesSection
          {...owners}
          registerLeaveGuard={registerSectionGuard}
        />
      )}

      {section === "git" && <ProjectGitSection {...owners} />}

      {section === "storage" && (
        <ProjectStorageSection
          {...owners}
          registerLeaveGuard={registerSectionGuard}
        />
      )}
    </>
  );
}
