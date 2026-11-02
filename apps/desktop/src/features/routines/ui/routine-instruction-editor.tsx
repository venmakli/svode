import { ControlledMarkdownEditor } from "@/features/editor";

import {
  useRoutineInstructionAutosave,
  type RoutineInstructionFlush,
} from "../hooks/use-routine-instruction-autosave";

/**
 * The instruction of a Routine in the editor of a page's content, saved by
 * itself as a page's content is, see `useRoutineInstructionAutosave`.
 */
export function RoutineInstructionEditor({
  body,
  disabled,
  label,
  placeholder,
  registerFlush,
  save,
}: {
  /** The saved instruction. */
  body: string;
  disabled: boolean;
  label: string;
  placeholder: string;
  /** Lets the screen's leave guard wait for the instruction to be written. */
  registerFlush(flush: RoutineInstructionFlush | null): void;
  /** Writes the instruction; rejects with the reason it was not saved. */
  save(body: string): Promise<void>;
}) {
  const { change, message, shown } = useRoutineInstructionAutosave({
    body,
    registerFlush,
    save,
  });

  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
      <div data-routine-instruction>
        <ControlledMarkdownEditor
          key={shown.revision}
          disabled={disabled}
          value={shown.body}
          placeholder={placeholder}
          onChange={change}
        />
      </div>
      {message ? (
        <span
          role="alert"
          className="text-xs text-destructive"
          data-routine-instruction-message
        >
          {message}
        </span>
      ) : null}
    </section>
  );
}
