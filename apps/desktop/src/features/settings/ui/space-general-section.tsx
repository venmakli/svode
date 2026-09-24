import { useId, useState } from "react";
import { Loader2 } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import type { SpaceGitType } from "@/features/space";
import { spaceGitTypeLabel } from "./owner-labels";
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowSkeleton,
} from "./settings-layout";

export interface SpaceGeneralEditor {
  status: "loading" | "ready" | "error";
  onRetry: () => void;
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
// has no editor and shows only its read-only facts; the editable rows wait for
// the owner's settings to load.
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
  const ready = editor?.status === "ready" ? editor : undefined;
  return (
    <SettingsGroup
      title={m.settings_general_details()}
      callout={
        editor?.status === "error" ? (
          <Alert>
            <AlertTitle>{m.settings_general_load_error_title()}</AlertTitle>
            <AlertDescription>
              <p>{m.settings_general_load_error()}</p>
              <div className="flex flex-wrap gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={editor.onRetry}
                >
                  {m.app_retry()}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : null
      }
    >
      {editor?.status === "loading" ? (
        <SettingsRowSkeleton key="name-loading" />
      ) : null}
      {editor?.status === "loading" ? (
        <SettingsRowSkeleton key="description-loading" />
      ) : null}
      {ready ? (
        <SettingsRow
          key="name"
          label={m.settings_general_icon_name()}
          htmlFor={`${id}-name`}
        >
          <EmojiPicker
            value={ready.icon}
            onChange={(icon) => write("icon", () => ready.onIconChange(icon))}
            size="sm"
          />
          <Input
            id={`${id}-name`}
            value={ready.name}
            readOnly={pending.has("name")}
            aria-disabled={busy("name")}
            aria-busy={busy("name")}
            onChange={(event) => ready.onNameChange(event.target.value)}
            onBlur={() => write("name", ready.onNameBlur)}
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
      {ready ? (
        <SettingsRow
          key="description"
          label={m.space_description_label()}
          htmlFor={`${id}-description`}
          layout="stacked"
        >
          <div className="relative">
            <Textarea
              id={`${id}-description`}
              value={ready.description}
              readOnly={pending.has("description")}
              aria-disabled={busy("description")}
              aria-busy={busy("description")}
              onChange={(event) =>
                ready.onDescriptionChange(event.target.value)
              }
              onBlur={() => write("description", ready.onDescriptionBlur)}
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
          {spaceGitTypeLabel(space.gitType) ? (
            <span className="text-sm">{spaceGitTypeLabel(space.gitType)}</span>
          ) : (
            <Skeleton aria-hidden className="h-4 w-28" />
          )}
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
