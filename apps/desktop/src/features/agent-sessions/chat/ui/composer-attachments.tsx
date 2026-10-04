import { useState, type ClipboardEvent } from "react";
import { File, FileText, HardDrive, Plus } from "lucide-react";
import { KEYS, type TComboboxInputElement } from "platejs";
import {
  PlateElement,
  type PlateEditor,
  type PlateElementProps,
} from "platejs/react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InlineCombobox,
  InlineComboboxContent,
  InlineComboboxEmpty,
  InlineComboboxGroup,
  InlineComboboxInput,
  InlineComboboxItem,
} from "@/components/ui/inline-combobox";
import { InputGroupButton } from "@/components/ui/input-group";
import { useSpace } from "@/features/space";
import {
  pickDiskFiles,
  readClipboardFilePaths,
  savePastedImage,
} from "../api/attachments";
import { useMentionTargets } from "../hooks/use-mention-targets";
import {
  attachmentElement,
  attachmentOf,
  fileUriToPath,
  type Attachment,
  type AttachmentElement,
} from "../model/attachments";
import { AttachmentBadge } from "./attachment-badge";
import * as m from "@/paraglide/messages.js";

/** An attachment badge inside the composer field. */
export function AttachmentElementView(
  props: PlateElementProps<AttachmentElement>,
) {
  const { element } = props;
  return (
    <PlateElement {...props} as="span">
      <span contentEditable={false}>
        <AttachmentBadge
          attachment={{ path: element.path, name: element.name }}
        />
      </span>
      {props.children}
    </PlateElement>
  );
}

/** Inserts badges where the cursor is, each followed by a space. */
export function insertAttachments(
  editor: PlateEditor,
  attachments: Attachment[],
) {
  if (attachments.length === 0) return;
  if (!editor.selection) editor.tf.select(editor.api.end([]));
  editor.tf.withoutNormalizing(() => {
    for (const attachment of attachments) {
      editor.tf.insertNodes(attachmentElement(attachment));
      editor.tf.move({ unit: "offset" });
      editor.tf.insertText(" ");
    }
  });
}

/** Opens the `@` search for pages and files at the cursor. */
function startMention(editor: PlateEditor) {
  editor.tf.focus({ edge: editor.selection ? undefined : "end" });
  editor.tf.insertNodes({
    type: KEYS.mentionInput,
    trigger: "@",
    children: [{ text: "" }],
  });
}

/** The `@` search: pages by title and files of the project by name. */
export function MentionSearchElement(
  props: PlateElementProps<TComboboxInputElement>,
) {
  const { editor, element } = props;
  const projectPath = useSpace((state) => state.activeRootPath);
  const [query, setQuery] = useState("");
  const targets = useMentionTargets(projectPath, query);

  return (
    <PlateElement {...props} as="span">
      <InlineCombobox
        element={element}
        trigger={typeof element.trigger === "string" ? element.trigger : "@"}
        filter={false}
        value={query}
        setValue={setQuery}
      >
        <InlineComboboxInput
          aria-label={m.sessions_chat_mention_search()}
          placeholder={m.sessions_chat_mention_search()}
          className="placeholder:text-muted-foreground"
        />
        <InlineComboboxContent>
          <InlineComboboxEmpty>{m.sessions_chat_mention_empty()}</InlineComboboxEmpty>
          <InlineComboboxGroup>
            {targets.map((target) => (
              <InlineComboboxItem
                key={target.attachment.path}
                value={target.attachment.path}
                label={target.attachment.name}
                className="h-auto min-h-[38px] items-center gap-2 py-1"
                onClick={() => insertAttachments(editor, [target.attachment])}
              >
                <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                  {target.icon && target.icon !== "📄" ? (
                    <span className="text-sm leading-none">{target.icon}</span>
                  ) : target.kind === "page" ? (
                    <FileText className="size-4" />
                  ) : (
                    <File className="size-4" />
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col justify-center leading-none">
                  <span className="truncate text-sm leading-4">
                    {target.attachment.name}
                  </span>
                  <span className="truncate text-[11px] leading-3 text-muted-foreground">
                    {target.location}
                  </span>
                </span>
              </InlineComboboxItem>
            ))}
          </InlineComboboxGroup>
        </InlineComboboxContent>
      </InlineCombobox>
      {props.children}
    </PlateElement>
  );
}

/** "+" in the composer field: a file from disk or a page or file of the project. */
export function AttachMenu({
  editor,
  disabled,
}: {
  editor: PlateEditor;
  disabled: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <InputGroupButton
          size="icon-sm"
          variant="ghost"
          className="rounded-full"
          disabled={disabled}
          aria-label={m.sessions_chat_attach()}
        >
          <Plus />
        </InputGroupButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DropdownMenuItem
          onSelect={() => {
            void pickDiskFiles().then((attachments) => {
              editor.tf.focus({ edge: editor.selection ? undefined : "end" });
              insertAttachments(editor, attachments);
            });
          }}
        >
          <HardDrive />
          {m.sessions_chat_attach_disk_file()}
        </DropdownMenuItem>
        <DropdownMenuItem
          // The search opens after the menu has given focus back.
          onSelect={() => window.setTimeout(() => startMention(editor))}
        >
          <FileText />
          {m.sessions_chat_attach_project()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Paste of files: a file copied in the file manager becomes a badge of the
 * original, an image without a path (a screenshot, an image from a
 * browser) is written to the system temp directory first. Text pastes as
 * usual.
 */
export function pasteAttachments(
  editor: PlateEditor,
  event: ClipboardEvent<HTMLDivElement>,
) {
  const data = event.clipboardData;
  const linked = data
    .getData("text/uri-list")
    .split(/\r?\n/)
    .flatMap((uri) => {
      const path = fileUriToPath(uri.trim());
      return path ? [attachmentOf(path)] : [];
    });
  if (!data.types.includes("Files") && linked.length === 0) return;
  event.preventDefault();
  const images = Array.from(data.files).filter((file) =>
    file.type.startsWith("image/"),
  );
  const text = data.getData("text/plain");
  void (async () => {
    let attachments = (await readClipboardFilePaths().catch(() => [])).map(
      (path) => attachmentOf(path),
    );
    if (attachments.length === 0) attachments = linked;
    if (attachments.length === 0) {
      for (const image of images) {
        try {
          const path = await savePastedImage(image);
          attachments.push(attachmentOf(path));
        } catch (error) {
          toast.error(
            m.sessions_chat_paste_failed({
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
    }
    if (attachments.length > 0) {
      insertAttachments(editor, attachments);
    } else if (text) {
      editor.tf.insertText(text);
    }
  })();
}
