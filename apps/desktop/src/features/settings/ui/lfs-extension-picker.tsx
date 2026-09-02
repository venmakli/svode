import { useMemo, useState } from "react";
import { Plus } from "lucide-react";

import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
} from "@/components/ui/combobox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import * as m from "@/paraglide/messages.js";

import {
  normalizeLfsExtension,
  type LfsExtensionDraftIssue,
} from "../model/storage-strategy";

const PRESET_EXTENSION_ORDER = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "heic",
  "tif",
  "tiff",
  "psd",
  "ai",
  "sketch",
  "mp3",
  "wav",
  "flac",
  "m4a",
  "ogg",
  "mp4",
  "mov",
  "m4v",
  "webm",
  "avi",
  "mkv",
  "pdf",
  "doc",
  "docx",
  "ppt",
  "pptx",
  "xls",
  "xlsx",
  "zip",
  "7z",
  "rar",
] as const;
const PRESET_EXTENSIONS = new Set<string>(PRESET_EXTENSION_ORDER);

interface ExtensionGroup {
  items: string[];
  label: string;
  value: string;
}

interface LfsExtensionPickerProps {
  describedBy?: string;
  disabled: boolean;
  invalid: boolean;
  onChange(value: string): void;
  value: string;
}

export function LfsExtensionPicker({
  describedBy,
  disabled,
  invalid,
  onChange,
  value,
}: LfsExtensionPickerProps) {
  const [customExtension, setCustomExtension] = useState("");
  const [customIssue, setCustomIssue] = useState<LfsExtensionDraftIssue | null>(
    null,
  );
  const selectedExtensions = useMemo(
    () => extensionValuesFromDraft(value),
    [value],
  );
  const groups = extensionGroups(selectedExtensions);

  const addCustomExtension = () => {
    const result = normalizeLfsExtension(customExtension);
    if (result.issue || result.extension === null) {
      setCustomIssue(result.issue ?? "invalid-extension");
      return;
    }
    onChange(
      extensionDraftFromValues([...selectedExtensions, result.extension]),
    );
    setCustomExtension("");
    setCustomIssue(null);
  };

  const customIssueMessage = customIssue
    ? {
        "invalid-extension": m.storage_lfs_extensions_invalid(),
        "protected-extension": m.storage_lfs_extensions_protected(),
      }[customIssue]
    : null;

  return (
    <div className="space-y-3">
      <Field>
        <FieldLabel htmlFor="storage-lfs-extensions">
          {m.storage_lfs_extensions_label()}
        </FieldLabel>
        <Combobox
          items={groups}
          multiple
          value={selectedExtensions}
          itemToStringLabel={(extension: string) => extension}
          itemToStringValue={(extension: string) => extension}
          filter={(extension: string, query) =>
            extension.includes(query.trim().replace(/^\.+/, "").toLowerCase())
          }
          onValueChange={(extensions) =>
            onChange(extensionDraftFromValues(extensions))
          }
        >
          <ComboboxInput
            id="storage-lfs-extensions"
            placeholder={m.storage_lfs_extensions_search()}
            className="w-full"
            disabled={disabled}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
          />
          <ComboboxContent>
            <ComboboxEmpty>
              {m.storage_lfs_extensions_no_results()}
            </ComboboxEmpty>
            <ComboboxList>
              {(group: ExtensionGroup, index) => (
                <ComboboxGroup key={group.value} items={group.items}>
                  <ComboboxLabel>{group.label}</ComboboxLabel>
                  <ComboboxCollection>
                    {(extension: string) => (
                      <ComboboxItem key={extension} value={extension}>
                        <span className="font-mono">.{extension}</span>
                      </ComboboxItem>
                    )}
                  </ComboboxCollection>
                  {index < groups.length - 1 ? <ComboboxSeparator /> : null}
                </ComboboxGroup>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
        <div className="flex items-start justify-between gap-3">
          <FieldDescription className="text-xs">
            {m.storage_lfs_extensions_hint()}
          </FieldDescription>
          <span className="shrink-0 text-xs text-muted-foreground">
            {m.storage_lfs_extensions_selected({
              count: String(selectedExtensions.length),
            })}
          </span>
        </div>
      </Field>

      <Field data-invalid={customIssueMessage ? true : undefined}>
        <FieldLabel htmlFor="storage-lfs-custom-extension">
          {m.storage_lfs_custom_extension_label()}
        </FieldLabel>
        <InputGroup className="max-w-64">
          <InputGroupAddon>.</InputGroupAddon>
          <InputGroupInput
            id="storage-lfs-custom-extension"
            value={customExtension}
            onChange={(event) => {
              setCustomExtension(event.target.value);
              setCustomIssue(null);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              addCustomExtension();
            }}
            placeholder={m.storage_lfs_custom_extension_placeholder()}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            aria-invalid={customIssueMessage ? true : undefined}
            aria-describedby={
              customIssueMessage ? "storage-lfs-custom-error" : undefined
            }
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              onClick={addCustomExtension}
              disabled={disabled || customExtension.trim().length === 0}
              aria-label={m.storage_lfs_custom_extension_add()}
            >
              <Plus />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        {customIssueMessage ? (
          <FieldError id="storage-lfs-custom-error" className="text-xs">
            {customIssueMessage}
          </FieldError>
        ) : (
          <FieldDescription className="text-xs">
            {m.storage_lfs_custom_extension_hint()}
          </FieldDescription>
        )}
      </Field>
    </div>
  );
}

function extensionValuesFromDraft(value: string): string[] {
  const values = new Set(
    value
      .split(/[\s,]+/)
      .map((extension) => extension.trim().replace(/^\.+/, "").toLowerCase())
      .filter(Boolean),
  );
  return [
    ...PRESET_EXTENSION_ORDER.filter((extension) => values.has(extension)),
    ...[...values]
      .filter((extension) => !PRESET_EXTENSIONS.has(extension))
      .sort(),
  ];
}

function extensionDraftFromValues(extensions: string[]): string {
  return [...new Set(extensions)].sort().join(", ");
}

function extensionGroups(selectedExtensions: string[]): ExtensionGroup[] {
  const groups: ExtensionGroup[] = [
    {
      value: "images",
      label: m.storage_lfs_group_images(),
      items: [
        "png",
        "jpg",
        "jpeg",
        "gif",
        "webp",
        "avif",
        "heic",
        "tif",
        "tiff",
      ],
    },
    {
      value: "design",
      label: m.storage_lfs_group_design(),
      items: ["psd", "ai", "sketch"],
    },
    {
      value: "audio",
      label: m.storage_lfs_group_audio(),
      items: ["mp3", "wav", "flac", "m4a", "ogg"],
    },
    {
      value: "video",
      label: m.storage_lfs_group_video(),
      items: ["mp4", "mov", "m4v", "webm", "avi", "mkv"],
    },
    {
      value: "documents",
      label: m.storage_lfs_group_documents(),
      items: ["pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx"],
    },
    {
      value: "archives",
      label: m.storage_lfs_group_archives(),
      items: ["zip", "7z", "rar"],
    },
  ];
  const custom = selectedExtensions.filter(
    (extension) => !PRESET_EXTENSIONS.has(extension),
  );
  if (custom.length > 0) {
    groups.push({
      value: "custom",
      label: m.storage_lfs_group_custom(),
      items: custom,
    });
  }
  return groups;
}
