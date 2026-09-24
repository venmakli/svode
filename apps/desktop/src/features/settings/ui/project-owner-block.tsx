import type { ReactNode } from "react";
import * as m from "@/paraglide/messages.js";
import { Badge } from "@/components/ui/badge";
import type { SpaceGitType, SpaceInfo } from "@/features/space";
import { spaceGitTypeLabel, spaceStatusLabel } from "./owner-labels";
import { SettingsOwnerBlock } from "./settings-layout";

const FOLDER_ICON = "\u{1F4C1}";

type HeadingRef = (node: HTMLElement | null) => void;

export function ProjectOwnerBlock({
  name,
  icon,
  headingRef,
  children,
}: {
  name: string;
  icon?: string | null;
  headingRef?: HeadingRef;
  children?: ReactNode;
}) {
  return (
    <SettingsOwnerBlock
      icon={icon || FOLDER_ICON}
      title={name}
      badges={<Badge variant="secondary">{m.settings_project_label()}</Badge>}
      headingRef={headingRef}
    >
      {children}
    </SettingsOwnerBlock>
  );
}

export function SpaceOwnerBlock({
  space,
  gitType,
  summary,
  collapsible,
  headingRef,
  children,
}: {
  space: SpaceInfo;
  gitType: SpaceGitType | null | undefined;
  summary?: ReactNode;
  collapsible?: { open: boolean; onOpenChange(open: boolean): void };
  headingRef?: HeadingRef;
  children?: ReactNode;
}) {
  const type = space.status === "ready" ? gitType : undefined;
  const status = spaceStatusLabel(space.status);
  return (
    <SettingsOwnerBlock
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
      summary={summary}
      collapsible={collapsible}
      headingRef={headingRef}
    >
      {children}
    </SettingsOwnerBlock>
  );
}
