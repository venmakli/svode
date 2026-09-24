import { useId, useState } from "react";
import { Loader2 } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { SpaceGitType } from "@/features/space";
import { spaceGitTypeLabel } from "./owner-labels";
import { SettingsGroup, SettingsRow } from "./settings-layout";

export interface SpaceGeneralEditor {
  icon: string;
  name: string;
  description: string;
  onIconChange: (value: string) => Promise<void>;
  onNameChange: (value: string) => void;
  onNameBlur: () => Promise<void>;
  onDescriptionChange: (value: string) => void;
  onDescriptionBlur: () => Promise<void>;
}

type Field = "icon" | "name" | "description";

// "Details" of the project or of one space. A space that is missing or broken
// has no editor and shows only its read-only facts.
export function SpaceGeneralSection({
  path,
  space,
  editor,
}: {
  path: string;
  space?: { gitType: SpaceGitType | null | undefined };
  editor?: SpaceGeneralEditor;
}) {
  const id = useId();
  const [pending, setPending] = useState<ReadonlySet<Field>>(() => new Set());
  // Each field writes on its own; a field stays read-only until its write ends.
  function write(field: Field, action: () => Promise<void>) {
    if (pending.has(field)) return;
    setPending((current) => new Set(current).add(field));
    void action().finally(() =>
      setPending((current) => {
        const next = new Set(current);
        next.delete(field);
        return next;
      }),
    );
  }
  const busy = (field: Field) => pending.has(field) || undefined;
  const pendingClassName =
    "aria-disabled:cursor-not-allowed aria-disabled:opacity-50";
  return (
    <SettingsGroup title={m.settings_general_details()}>
      {editor ? (
        <SettingsRow
          key="name"
          label={m.settings_general_icon_name()}
          htmlFor={`${id}-name`}
        >
          <EmojiPicker
            value={editor.icon}
            onChange={(icon) => write("icon", () => editor.onIconChange(icon))}
            size="sm"
          />
          <Input
            id={`${id}-name`}
            value={editor.name}
            readOnly={pending.has("name")}
            aria-disabled={busy("name")}
            aria-busy={busy("name")}
            onChange={(event) => editor.onNameChange(event.target.value)}
            onBlur={() => write("name", editor.onNameBlur)}
            placeholder={m.space_name_placeholder()}
            className={`w-64 max-w-full ${pendingClassName}`}
          />
          {pending.has("icon") || pending.has("name") ? (
            <Loader2
              aria-hidden
              className="size-4 animate-spin text-muted-foreground"
            />
          ) : null}
        </SettingsRow>
      ) : null}
      {editor ? (
        <SettingsRow
          key="description"
          label={m.space_description_label()}
          htmlFor={`${id}-description`}
          layout="stacked"
        >
          <div className="relative">
            <Textarea
              id={`${id}-description`}
              value={editor.description}
              readOnly={pending.has("description")}
              aria-disabled={busy("description")}
              aria-busy={busy("description")}
              onChange={(event) =>
                editor.onDescriptionChange(event.target.value)
              }
              onBlur={() => write("description", editor.onDescriptionBlur)}
              placeholder={m.space_description_placeholder()}
              rows={3}
              className={pendingClassName}
            />
            {pending.has("description") ? (
              <Loader2
                aria-hidden
                className="absolute top-2 right-2 size-4 animate-spin text-muted-foreground"
              />
            ) : null}
          </div>
        </SettingsRow>
      ) : null}
      {space ? (
        <SettingsRow
          key="type"
          label={m.space_type_label()}
          description={spaceGitTypeDescription(space.gitType)}
        >
          <span className="text-sm">
            {spaceGitTypeLabel(space.gitType) ?? m.common_loading()}
          </span>
        </SettingsRow>
      ) : null}
      <SettingsRow key="path" label={m.space_path_label()} layout="stacked">
        <p className="font-mono text-sm break-all text-muted-foreground">
          {path}
        </p>
      </SettingsRow>
    </SettingsGroup>
  );
}

function spaceGitTypeDescription(gitType: SpaceGitType | null | undefined) {
  switch (gitType) {
    case "inline":
      return m.space_type_inline_desc();
    case "independent":
      return m.space_type_independent_desc();
    case "submodule":
      return m.space_type_submodule_desc();
    default:
      return undefined;
  }
}
