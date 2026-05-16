import { CoverBanner } from "./cover-banner";
import { TitleZone } from "./title-zone";
import type { EntryCover } from "./types";

interface EntryIdentityHeaderProps {
  title: string;
  icon: string | null;
  description: string;
  cover: EntryCover | null;
  projectPath: string | null;
  spacePath: string;
  documentPath: string | null;
  onTitleChange: (title: string) => void;
  onIconChange: (icon: string) => void;
  onDescriptionChange: (description: string) => void;
  onCoverChange: (cover: EntryCover | null) => void;
  onBodyFocus: () => void;
  titleClassName?: string;
}

export function EntryIdentityHeader({
  title,
  icon,
  description,
  cover,
  projectPath,
  spacePath,
  documentPath,
  onTitleChange,
  onIconChange,
  onDescriptionChange,
  onCoverChange,
  onBodyFocus,
  titleClassName,
}: EntryIdentityHeaderProps) {
  return (
    <>
      <CoverBanner
        cover={cover}
        projectPath={projectPath}
        spacePath={spacePath}
        documentPath={documentPath}
        onCoverChange={onCoverChange}
      />
      <div className={titleClassName}>
        <TitleZone
          title={title}
          icon={icon}
          description={description}
          onTitleChange={onTitleChange}
          onIconChange={onIconChange}
          onDescriptionChange={onDescriptionChange}
          onBodyFocus={onBodyFocus}
        />
      </div>
    </>
  );
}
