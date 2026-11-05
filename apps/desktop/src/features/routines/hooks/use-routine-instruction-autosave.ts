import { useCallback, useEffect, useRef, useState } from "react";

import { useSignalUserEdit } from "@/features/navigation";
import * as m from "@/paraglide/messages.js";

/** How long the instruction waits after the last change before it is saved. */
export const ROUTINE_INSTRUCTION_SAVE_DELAY_MS = 1000;

/**
 * Saves the instruction typed so far and resolves once it is written: true
 * when nothing is left unsaved, false when the write was refused.
 */
export type RoutineInstructionFlush = () => Promise<boolean>;

/**
 * The instruction of a Routine saved by itself as a page's content is:
 * shortly after the last change, through the owner, which writes one
 * Routine at a time. A refused write puts the saved instruction back with
 * the reason. An update of the Routine from disk leaves an instruction that
 * is still being saved as it is. Leaving writes what was typed.
 *
 * A change the user types keeps the Routine the main area shows in Now, as
 * typing in a page's content does; showing the instruction, drawing it again
 * after a change on disk and the write on leaving do not, since the main area
 * may already show the next object by then.
 */
export function useRoutineInstructionAutosave({
  body,
  registerFlush,
  save,
}: {
  /** The saved instruction. */
  body: string;
  /** Lets the screen's leave guard wait for the instruction to be written. */
  registerFlush(flush: RoutineInstructionFlush | null): void;
  /** Writes the instruction; rejects with the reason it was not saved. */
  save(body: string): Promise<void>;
}) {
  // The instruction the editor was drawn with; a new revision draws it again.
  const [shown, setShown] = useState({ body, revision: 0 });
  const [message, setMessage] = useState<string | null>(null);
  // The editor holds an instruction that is not written yet.
  const [dirty, setDirty] = useState(false);
  // The instruction the editor holds once nothing is left to write.
  const [settled, setSettled] = useState(body);
  const draftRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writingRef = useRef<Promise<boolean> | null>(null);
  const saveRef = useRef(save);
  const bodyRef = useRef(body);
  useEffect(() => {
    saveRef.current = save;
    bodyRef.current = body;
  });

  // An instruction changed on disk replaces the shown one, unless the
  // editor holds one that is not written yet.
  const [knownBody, setKnownBody] = useState(body);
  if (knownBody !== body) {
    setKnownBody(body);
    if (!dirty && body !== settled) {
      setSettled(body);
      setShown((current) => ({ body, revision: current.revision + 1 }));
    }
  }

  const flush = useCallback<RoutineInstructionFlush>(async () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const previous = writingRef.current;
    if (previous) await previous;
    const draft = draftRef.current;
    if (draft === null) return true;
    draftRef.current = null;
    const write = saveRef.current(draft).then(
      () => {
        setMessage(null);
        setSettled(draft);
        return true;
      },
      (error: unknown) => {
        if (draftRef.current === null) {
          // The editor shows the saved instruction again with the reason.
          const saved = bodyRef.current;
          setMessage(
            m.routines_instruction_not_saved({
              reason:
                error instanceof Error && error.message
                  ? error.message
                  : m.property_write_failed(),
            }),
          );
          setSettled(saved);
          setShown((current) => ({
            body: saved,
            revision: current.revision + 1,
          }));
        }
        return false;
      },
    );
    writingRef.current = write;
    const written = await write;
    if (writingRef.current === write) writingRef.current = null;
    if (draftRef.current === null && timerRef.current === null) {
      setDirty(false);
    }
    return written;
  }, []);

  useEffect(() => {
    registerFlush(flush);
    return () => {
      registerFlush(null);
      // Leaving the screen writes what was typed.
      void flush();
    };
  }, [flush, registerFlush]);

  const signalUserEdit = useSignalUserEdit();
  // The editor reports only changes of its content, never the instruction
  // it was drawn with.
  const change = useCallback(
    (next: string) => {
      signalUserEdit();
      draftRef.current = next;
      setDirty(true);
      setMessage(null);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void flush();
      }, ROUTINE_INSTRUCTION_SAVE_DELAY_MS);
    },
    [flush, signalUserEdit],
  );

  return { change, message, shown };
}
