import { useState } from "react";
import { ChevronDown, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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

const EXTENSION_GROUPS = [
  {
    value: "images",
    items: ["png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "tif", "tiff"],
  },
  { value: "design", items: ["psd", "ai", "sketch"] },
  { value: "audio", items: ["mp3", "wav", "flac", "m4a", "ogg"] },
  {
    value: "video",
    items: ["mp4", "mov", "m4v", "webm", "avi", "mkv"],
  },
  {
    value: "documents",
    items: ["pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx"],
  },
  { value: "archives", items: ["zip", "7z", "rar"] },
] as const;

const PRESET_EXTENSION_ORDER = EXTENSION_GROUPS.flatMap((group) => group.items);
const PRESET_EXTENSIONS = new Set<string>(PRESET_EXTENSION_ORDER);

type ExtensionGroup = (typeof EXTENSION_GROUPS)[number];
type ExtensionGroupValue = ExtensionGroup["value"];

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
  const [openGroup, setOpenGroup] = useState<ExtensionGroupValue | null>(null);
  const selectedExtensions = extensionValuesFromDraft(value);
  const selectedExtensionSet = new Set(selectedExtensions);
  const customExtensions = selectedExtensions.filter(
    (extension) => !PRESET_EXTENSIONS.has(extension),
  );

  const updateSelection = (extensions: string[]) => {
    onChange(extensionDraftFromValues(extensions));
  };

  const toggleExtension = (extension: string, checked: boolean) => {
    updateSelection(
      checked
        ? [...selectedExtensions, extension]
        : selectedExtensions.filter((value) => value !== extension),
    );
  };

  const toggleGroup = (group: ExtensionGroup, checked: boolean) => {
    const groupExtensions = new Set<string>(group.items);
    updateSelection(
      checked
        ? [...selectedExtensions, ...group.items]
        : selectedExtensions.filter(
            (extension) => !groupExtensions.has(extension),
          ),
    );
  };

  const addCustomExtension = () => {
    const result = normalizeLfsExtension(customExtension);
    if (result.issue || result.extension === null) {
      setCustomIssue(result.issue ?? "invalid-extension");
      return;
    }
    updateSelection([...selectedExtensions, result.extension]);
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
    <div className="space-y-4">
      <Field data-invalid={invalid || undefined}>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel id="storage-lfs-extensions-label">
            {m.storage_lfs_extensions_label()}
          </FieldLabel>
          <span className="shrink-0 text-xs text-muted-foreground">
            {m.storage_lfs_extensions_selected({
              count: String(selectedExtensions.length),
            })}
          </span>
        </div>
        <FieldDescription id="storage-lfs-extensions-hint" className="text-xs">
          {m.storage_lfs_extensions_hint()}
        </FieldDescription>

        <div
          className="space-y-2"
          role="group"
          aria-labelledby="storage-lfs-extensions-label"
          aria-describedby={
            describedBy
              ? `storage-lfs-extensions-hint ${describedBy}`
              : "storage-lfs-extensions-hint"
          }
          aria-invalid={invalid || undefined}
        >
          {EXTENSION_GROUPS.map((group) => {
            const label = extensionGroupLabel(group.value);
            const selectedCount = group.items.filter((extension) =>
              selectedExtensionSet.has(extension),
            ).length;
            const groupChecked = selectionState(
              selectedCount,
              group.items.length,
            );
            const isOpen = openGroup === group.value;

            return (
              <Collapsible
                key={group.value}
                open={isOpen}
                onOpenChange={(open) => setOpenGroup(open ? group.value : null)}
                className="rounded-lg border border-border bg-muted/15"
              >
                <div className="flex min-h-11 items-center gap-3 px-3">
                  <Checkbox
                    id={`storage-lfs-group-${group.value}`}
                    checked={groupChecked}
                    onCheckedChange={(checked) =>
                      toggleGroup(group, checked === true)
                    }
                    disabled={disabled}
                    aria-label={m.storage_lfs_group_toggle({ group: label })}
                  />
                  <CollapsibleTrigger
                    id={`storage-lfs-group-${group.value}-toggle`}
                    className="group flex min-w-0 flex-1 items-center gap-3 py-2 text-left outline-none focus-visible:rounded-md focus-visible:ring-3 focus-visible:ring-ring/50"
                    disabled={disabled}
                    aria-label={
                      isOpen
                        ? m.storage_lfs_group_collapse({ group: label })
                        : m.storage_lfs_group_expand({ group: label })
                    }
                  >
                    <span className="min-w-0 flex-1 text-sm font-medium">
                      {label}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {m.storage_lfs_group_selected({
                        selected: String(selectedCount),
                        total: String(group.items.length),
                      })}
                    </span>
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                  </CollapsibleTrigger>
                </div>
                <CollapsibleContent>
                  <div className="grid grid-cols-2 gap-1 border-t border-border p-2 sm:grid-cols-3 lg:grid-cols-4">
                    {group.items.map((extension) => (
                      <label
                        key={extension}
                        htmlFor={`storage-lfs-extension-${extension}`}
                        className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm hover:bg-muted has-disabled:cursor-not-allowed has-disabled:opacity-50"
                      >
                        <Checkbox
                          id={`storage-lfs-extension-${extension}`}
                          checked={selectedExtensionSet.has(extension)}
                          onCheckedChange={(checked) =>
                            toggleExtension(extension, checked === true)
                          }
                          disabled={disabled}
                        />
                        <span className="font-mono">.{extension}</span>
                      </label>
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
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
        {customExtensions.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {customExtensions.map((extension) => (
              <Button
                key={extension}
                id={`storage-lfs-custom-${extension}`}
                type="button"
                variant="secondary"
                size="xs"
                onClick={() => toggleExtension(extension, false)}
                disabled={disabled}
                aria-label={m.storage_lfs_custom_extension_remove({
                  extension: `.${extension}`,
                })}
              >
                <span className="font-mono">.{extension}</span>
                <X />
              </Button>
            ))}
          </div>
        ) : null}
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

function selectionState(
  selectedCount: number,
  totalCount: number,
): boolean | "indeterminate" {
  if (selectedCount === 0) return false;
  if (selectedCount === totalCount) return true;
  return "indeterminate";
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

function extensionGroupLabel(group: ExtensionGroupValue): string {
  return {
    images: m.storage_lfs_group_images(),
    design: m.storage_lfs_group_design(),
    audio: m.storage_lfs_group_audio(),
    video: m.storage_lfs_group_video(),
    documents: m.storage_lfs_group_documents(),
    archives: m.storage_lfs_group_archives(),
  }[group];
}
