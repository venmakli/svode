import { dictatedText, useDictatedTexts } from "@/features/voice-input";
import { appendComposerDraftText } from "../model/composer";

/**
 * Puts the text dictated before this window reloaded at the end of the
 * draft it was dictated into, unsent (`06`, stop from outside), whether or
 * not that session's composer is shown. Runs once per window.
 */
export function useDictatedDrafts() {
  useDictatedTexts((key, text) =>
    appendComposerDraftText(key, (before) => dictatedText(text, before)),
  );
}
