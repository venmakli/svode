import { useEffect, useRef, type ReactNode } from "react";
import { ArrowUp, Loader2, Square } from "lucide-react";
import { NodeApi, SingleBlockPlugin, type Value } from "platejs";
import { Plate, usePlateEditor } from "platejs/react";
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
import { composerKeyAction } from "../model/composer";
import * as m from "@/paraglide/messages.js";

function valueOf(text: string): Value {
  return [{ type: "p", children: [{ text }] }];
}

export interface ComposerProps {
  text: string;
  onTextChange: (text: string) => void;
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
  autoFocus?: boolean;
  className?: string;
}

/**
 * The composer field (Stage 10 `04`): a small Plate editor with one root
 * block, so line breaks stay `\n` and nothing is rendered as markdown.
 * Enter sends, Shift+Enter breaks the line, Enter that ends an IME
 * composition only ends it, and Esc stops a running turn.
 */
export function Composer({
  text,
  onTextChange,
  onSend,
  onStop,
  running,
  cancelling,
  sending,
  canSend,
  placeholder,
  controls,
  autoFocus = false,
  className,
}: ComposerProps) {
  const editor = usePlateEditor({
    plugins: [SingleBlockPlugin],
    value: valueOf(text),
  });
  const emittedRef = useRef(text);

  // A draft changed outside the field — cleared after a send, restored
  // after one that did not reach the agent — replaces its content.
  useEffect(() => {
    if (text === emittedRef.current) return;
    emittedRef.current = text;
    editor.tf.setValue(valueOf(text));
    if (text) editor.tf.select(editor.api.end([]));
  }, [editor, text]);

  useEffect(() => {
    if (autoFocus) editor.tf.focus({ edge: "end" });
  }, [autoFocus, editor]);

  const hasText = text.trim().length > 0;
  const sendDisabled = !hasText || !canSend || sending;

  return (
    <InputGroup
      className={cn(
        "h-auto flex-col items-stretch rounded-xl bg-background shadow-xs has-[[data-slot=input-group-control]:focus]:border-ring has-[[data-slot=input-group-control]:focus]:ring-3 has-[[data-slot=input-group-control]:focus]:ring-ring/50",
        className,
      )}
      data-sending={sending || undefined}
    >
      <Plate
        editor={editor}
        readOnly={sending}
        onChange={({ value }) => {
          const next = NodeApi.string({ type: "p", children: value });
          if (next === emittedRef.current) return;
          emittedRef.current = next;
          onTextChange(next);
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
            onKeyDown={(event) => {
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
