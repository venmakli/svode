import { useEffect, useRef, type ReactNode } from "react";
import { ArrowUp, Loader2, Square } from "lucide-react";
import { MentionInputPlugin, MentionPlugin } from "@platejs/mention/react";
import { SingleBlockPlugin } from "platejs";
import { createPlatePlugin, Plate, usePlateEditor } from "platejs/react";
import { Editor, EditorContainer } from "@/components/ui/editor";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
} from "@/components/ui/input-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import {
  ATTACHMENT_ELEMENT,
  draftParts,
  draftValue,
  isDraftBlank,
  type DraftPart,
} from "../model/attachments";
import type { AgentSessionCommandDto } from "../api/chat";
import { composerKeyAction } from "../model/composer";
import { COMMAND_PLUGINS, SessionCommandsPlugin } from "./composer-commands";
import {
  AttachMenu,
  AttachmentElementView,
  MentionSearchElement,
  pasteAttachments,
} from "./composer-attachments";
import * as m from "@/paraglide/messages.js";

const AttachmentPlugin = createPlatePlugin({
  key: ATTACHMENT_ELEMENT,
  node: { isElement: true, isInline: true, isVoid: true },
}).withComponent(AttachmentElementView);

const COMPOSER_PLUGINS = [
  SingleBlockPlugin,
  AttachmentPlugin,
  MentionPlugin,
  MentionInputPlugin.withComponent(MentionSearchElement),
  ...COMMAND_PLUGINS,
];

export interface ComposerProps {
  /** Text and attachment badges in order. */
  parts: DraftPart[];
  onPartsChange: (parts: DraftPart[]) => void;
  onSend: () => void;
  onStop: () => void;
  /** A turn runs: the one action is stop, and the draft can still be typed. */
  running: boolean;
  cancelling: boolean;
  /** The prompt is on its way; the text stays until the runtime takes it. */
  sending: boolean;
  /** Sending is possible now: the agent and the writer allow it. */
  canSend: boolean;
  placeholder: string;
  /** Controls inside the field, left of the primary action. */
  controls?: ReactNode;
  /** The agent's slash commands; without them `/` is a plain character. */
  commands?: AgentSessionCommandDto[];
  autoFocus?: boolean;
  className?: string;
}

/**
 * The composer field (Stage 10 `04`): a small Plate editor with one root
 * block, so line breaks stay `\n` and nothing is rendered as markdown.
 * Attachments are inline badges where they were added: "+", an `@`
 * search or a paste. Enter sends, Shift+Enter breaks the line, Enter that
 * ends an IME composition only ends it, and Esc stops a running turn.
 */
export function Composer({
  parts,
  onPartsChange,
  onSend,
  onStop,
  running,
  cancelling,
  sending,
  canSend,
  placeholder,
  controls,
  commands = NO_COMMANDS,
  autoFocus = false,
  className,
}: ComposerProps) {
  const editor = usePlateEditor({
    plugins: COMPOSER_PLUGINS,
    value: draftValue(parts),
  });
  const draftKey = JSON.stringify(parts);
  const emittedRef = useRef(draftKey);

  // A draft changed outside the field — cleared after a send, restored
  // after one that did not reach the agent — replaces its content.
  useEffect(() => {
    if (draftKey === emittedRef.current) return;
    emittedRef.current = draftKey;
    const next = JSON.parse(draftKey) as DraftPart[];
    editor.tf.setValue(draftValue(next));
    if (next.length > 0) editor.tf.select(editor.api.end([]));
  }, [draftKey, editor]);

  useEffect(() => {
    if (autoFocus) editor.tf.focus({ edge: "end" });
  }, [autoFocus, editor]);

  useEffect(() => {
    editor.setOption(SessionCommandsPlugin, "commands", commands);
  }, [commands, editor]);

  const sendDisabled = isDraftBlank(parts) || !canSend || sending;

  return (
    <InputGroup
      className={cn(
        "@container/composer h-auto flex-col items-stretch rounded-xl bg-background shadow-xs has-[[data-slot=input-group-control]:focus]:border-ring has-[[data-slot=input-group-control]:focus]:ring-3 has-[[data-slot=input-group-control]:focus]:ring-ring/50",
        className,
      )}
      data-sending={sending || undefined}
    >
      <Plate
        editor={editor}
        readOnly={sending}
        onChange={({ value }) => {
          const next = draftParts(value);
          const key = JSON.stringify(next);
          if (key === emittedRef.current) return;
          emittedRef.current = key;
          onPartsChange(next);
        }}
      >
        <EditorContainer className="max-h-60 min-h-0 overflow-y-auto">
          <Editor
            data-slot="input-group-control"
            variant="none"
            aria-label={m.sessions_chat_composer_label()}
            placeholder={placeholder}
            className={cn(
              "min-h-11 px-3 pt-3 pb-1 text-sm",
              sending && "text-muted-foreground",
            )}
            onPaste={(event) => pasteAttachments(editor, event)}
            onKeyDown={(event) => {
              // Enter and Esc in an open `@` or `/` search choose or close
              // it first.
              if (
                event.defaultPrevented ||
                (event.target instanceof Element &&
                  event.target.closest('[role="combobox"]'))
              ) {
                return;
              }
              const action = composerKeyAction(event.nativeEvent, running);
              if (action === "send") {
                event.preventDefault();
                if (!running && !sendDisabled) onSend();
              } else if (action === "stop") {
                event.preventDefault();
                onStop();
              }
            }}
          />
        </EditorContainer>
      </Plate>
      <InputGroupAddon align="block-end" className="gap-1 pt-1">
        <AttachMenu
          editor={editor}
          disabled={sending}
          commands={commands.length > 0}
        />
        {controls}
        <div className="ms-auto flex items-center gap-2">
          {sending && (
            <span className="text-xs text-muted-foreground">
              {m.sessions_chat_sending()}
            </span>
          )}
          <PrimaryAction
            running={running}
            cancelling={cancelling}
            sending={sending}
            disabled={sendDisabled}
            onSend={onSend}
            onStop={onStop}
          />
        </div>
      </InputGroupAddon>
    </InputGroup>
  );
}

const NO_COMMANDS: AgentSessionCommandDto[] = [];

function PrimaryAction({
  running,
  cancelling,
  sending,
  disabled,
  onSend,
  onStop,
}: {
  running: boolean;
  cancelling: boolean;
  sending: boolean;
  disabled: boolean;
  onSend: () => void;
  onStop: () => void;
}) {
  if (running) {
    const label = cancelling
      ? m.sessions_chat_stopping()
      : m.sessions_chat_stop();
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <InputGroupButton
            size="icon-sm"
            variant="default"
            className="rounded-full"
            disabled={cancelling}
            aria-label={label}
            onClick={onStop}
          >
            {cancelling ? <Loader2 className="animate-spin" /> : <Square />}
          </InputGroupButton>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <InputGroupButton
      size="icon-sm"
      variant="default"
      className="rounded-full"
      disabled={disabled}
      aria-label={m.sessions_chat_send()}
      onClick={onSend}
    >
      {sending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
    </InputGroupButton>
  );
}
