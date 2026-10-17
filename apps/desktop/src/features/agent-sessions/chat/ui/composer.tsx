import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ArrowUp, Loader2, Square } from "lucide-react";
import { MentionInputPlugin, MentionPlugin } from "@platejs/mention/react";
import { SingleBlockPlugin, type Value } from "platejs";
import {
  createPlatePlugin,
  Plate,
  usePlateEditor,
  type PlateEditor,
} from "platejs/react";
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
import {
  DICTATION_KEY_CODE,
  RecordingRow,
  showsRecordingRow,
  VoiceInputButton,
} from "@/features/voice-input";
import { SystemDictationPlugin } from "@/features/editor/system-dictation";
import { isResourceDrag } from "@/features/space/resource-drag";
import { matchesPhysicalShortcut } from "@/shared/lib/keyboard-shortcuts";
import { cn } from "@/shared/lib/utils";
import {
  ATTACHMENT_ELEMENT,
  draftParts,
  draftValue,
  isDraftBlank,
  type DraftPart,
} from "../model/attachments";
import type { AgentSessionCommandDto } from "../api/chat";
import { takeEscape } from "@/shared/lib/escape-key";
import { isKeyTaken } from "../../lib/session-content";
import { composerKeyAction } from "../model/composer";
import { useComposerDictation } from "../hooks/use-composer-dictation";
import {
  holdComposerFocus,
  useComposerFocusReturn,
} from "../hooks/use-composer-focus";
import {
  useComposerDropReceiver,
  type ComposerDropReceiver,
} from "../hooks/use-chat-drop";
import { COMMAND_PLUGINS, SessionCommandsPlugin } from "./composer-commands";
import {
  AttachMenu,
  AttachmentElementView,
  insertDroppedAttachments,
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
  SystemDictationPlugin,
];

export interface ComposerProps {
  /** The draft's storage key; dictation delivers into it (`06`). */
  draftKey: string;
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
 * search, a paste or a drop on the session surface. Enter sends, Shift+Enter breaks the line, Enter that
 * ends an IME composition only ends it, and Esc stops a running turn.
 * The microphone dictates into the field; while it records, the recording
 * row takes the place of the bottom row and Esc cancels the recording.
 */
export function Composer({
  draftKey,
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
  const rootRef = useRef<HTMLDivElement>(null);
  const partsKey = JSON.stringify(parts);
  const emittedRef = useRef(partsKey);

  // A draft changed outside the field — cleared after a send, restored
  // after one that did not reach the agent — replaces its content.
  useEffect(() => {
    if (partsKey === emittedRef.current) return;
    emittedRef.current = partsKey;
    const next = JSON.parse(partsKey) as DraftPart[];
    editor.tf.setValue(draftValue(next));
    if (next.length > 0) editor.tf.select(editor.api.end([]));
  }, [partsKey, editor]);

  const { dictation, sendAfterRef } = useComposerDictation(editor, draftKey);
  useComposerDropReceiver(
    useMemo<ComposerDropReceiver | null>(
      () =>
        sending
          ? null
          : {
              insert: (attachments, point) =>
                insertDroppedAttachments(editor, attachments, point),
            },
      [editor, sending],
    ),
  );
  const dictating = dictation.state.phase !== "idle";

  useEffect(() => {
    if (autoFocus) editor.tf.focus({ edge: "endEditor" });
  }, [autoFocus, editor]);

  useEffect(() => {
    editor.setOption(SessionCommandsPlugin, "commands", commands);
  }, [commands, editor]);

  const sendDisabled = isDraftBlank(parts) || !canSend || sending;
  // The field takes focus back after the send (DF-197).
  const send = useCallback(() => {
    holdComposerFocus(draftKey, rootRef.current);
    onSend();
  }, [draftKey, onSend]);

  /**
   * The hotkey starts or stops dictation as ■; Esc cancels a recording
   * rather than the turn. True when the key was dictation's.
   */
  const dictationKey = (event: KeyboardEvent) => {
    if (matchesPhysicalShortcut(event, DICTATION_KEY_CODE, true)) {
      event.preventDefault();
      if (!sending) dictation.toggle();
      return true;
    }
    if (event.key === "Escape" && dictating && !isKeyTaken(event)) {
      takeEscape(event);
      dictation.cancel();
      return true;
    }
    return false;
  };

  // The field reads its handlers when keys and changes come, so a render of
  // the composer — as every update of a running turn — does not render it.
  const fieldEventsRef = useRef<FieldEvents | null>(null);
  useLayoutEffect(() => {
    fieldEventsRef.current = {
      onChange: (value) => {
        const next = draftParts(value);
        const key = JSON.stringify(next);
        if (key === emittedRef.current) return;
        emittedRef.current = key;
        onPartsChange(next);
      },
      onKeyDown: (event) => {
        // Enter and Esc in an open `@` or `/` search choose or close
        // it first.
        // Before the editor's own handling, which takes some keys.
        if (dictationKey(event.nativeEvent)) return;
        if (isKeyTaken(event.nativeEvent)) return;
        const action = composerKeyAction(event.nativeEvent, running);
        if (action === "send") {
          event.preventDefault();
          if (!running && !sendDisabled) send();
        } else if (action === "stop") {
          takeEscape(event.nativeEvent);
          onStop();
        }
      },
    };
  });
  const fieldEvents = useMemo<FieldEvents>(
    () => ({
      onChange: (value) => fieldEventsRef.current?.onChange(value),
      onKeyDown: (event) => fieldEventsRef.current?.onKeyDown(event),
    }),
    [],
  );

  // ↑ sends once the dictated text is in the draft.
  useEffect(() => {
    if (sendAfterRef.current === null || sendAfterRef.current !== partsKey) return;
    sendAfterRef.current = null;
    if (!running && !sendDisabled) send();
  }, [send, partsKey, running, sendAfterRef, sendDisabled]);

  return (
    <InputGroup
      ref={rootRef}
      className={cn(
        // Looks the same in every state: a disabled send or attach button
        // does not dim the group, and the caret alone marks focus.
        "@container/composer h-auto flex-col items-stretch rounded-xl bg-background shadow-xs has-disabled:bg-background has-disabled:opacity-100 has-[[data-slot=input-group-control]:focus-visible]:border-input has-[[data-slot=input-group-control]:focus-visible]:ring-0 dark:has-disabled:bg-input/30",
        className,
      )}
      data-sending={sending || undefined}
      // Focus on the recording row's buttons.
      onKeyDown={(event) => dictationKey(event.nativeEvent)}
    >
      <ComposerField
        editor={editor}
        draftKey={draftKey}
        root={rootRef}
        sending={sending}
        placeholder={placeholder}
        events={fieldEvents}
      />
      <InputGroupAddon align="block-end" className="gap-1 pt-1">
        {showsRecordingRow(dictation.state) ? (
          <RecordingRow
            dictation={dictation}
            canSend={canSend && !running && !sending}
          />
        ) : (
          <>
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
          <VoiceInputButton dictation={dictation} disabled={sending} />
          <PrimaryAction
            running={running}
            cancelling={cancelling}
            sending={sending}
            disabled={sendDisabled}
            onSend={send}
            onStop={onStop}
          />
        </div>
          </>
        )}
      </InputGroupAddon>
    </InputGroup>
  );
}

const NO_COMMANDS: AgentSessionCommandDto[] = [];

interface FieldEvents {
  onChange: (value: Value) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

/**
 * The editor of the composer. Slate puts the page caret back where its own
 * selection is on every render, so a render between a click and its
 * reading of the click would move the caret: the field renders only when
 * what it shows changes, not on updates of a running turn (DF-197).
 */
const ComposerField = memo(function ComposerField({
  editor,
  draftKey,
  root,
  sending,
  placeholder,
  events,
}: {
  editor: PlateEditor;
  draftKey: string;
  root: RefObject<HTMLElement | null>;
  sending: boolean;
  placeholder: string;
  events: FieldEvents;
}) {
  return (
    <Plate
      editor={editor}
      readOnly={sending}
      onChange={({ value }) => events.onChange(value)}
    >
      <FocusReturn draftKey={draftKey} root={root} />
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
          // Files and sidebar resources go to the session surface, which
          // inserts them as badges, rather than in as their text.
          onDrop={(event) => isResourceDrag(event.dataTransfer)}
          onKeyDown={events.onKeyDown}
        />
      </EditorContainer>
    </Plate>
  );
});

function FocusReturn({
  draftKey,
  root,
}: {
  draftKey: string;
  root: RefObject<HTMLElement | null>;
}) {
  useComposerFocusReturn(draftKey, root);
  return null;
}

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
