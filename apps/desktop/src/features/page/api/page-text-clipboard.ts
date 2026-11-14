/** Puts the Markdown text of a Page on the clipboard. */
export async function copyPageText(text: string): Promise<void> {
  if (!navigator.clipboard) throw new Error("Clipboard is not available");
  await navigator.clipboard.writeText(text);
}
