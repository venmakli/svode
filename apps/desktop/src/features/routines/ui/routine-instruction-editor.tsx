import { ControlledMarkdownEditor } from "@/features/editor";
import { detailPageFramedBodyClassName } from "@/shared/ui/page-layout";

import {
  useRoutineInstructionAutosave,
  type RoutineInstructionFlush,
} from "../hooks/use-routine-instruction-autosave";

/**
 * The instruction of a Routine as the body of a page, saved by itself as a
 * page's content is, see `useRoutineInstructionAutosave`. It shows no label:
 * `label` names the body for assistive technologies.
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
    <div className="flex min-w-0 flex-col">
      <div className={detailPageFramedBodyClassName} data-routine-instruction>
        <ControlledMarkdownEditor
          key={shown.revision}
          disabled={disabled}
          label={label}
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
    </div>
  );
}
