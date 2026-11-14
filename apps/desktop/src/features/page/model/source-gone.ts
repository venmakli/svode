/**
 * The "file gone" state of a Page session: its file disappeared outside this
 * window while it held unsaved work, which stays open until the user
 * restores the file, copies the text or closes without saving (DF-269 R3).
 */
export interface PageGoneState {
  /** A restore of the file is in flight. */
  pending: boolean;
  /** Why the last restore was refused. */
  error: string | null;
}
