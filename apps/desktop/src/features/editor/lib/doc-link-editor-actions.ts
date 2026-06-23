import { upsertLink } from "@platejs/link";
import { LinkPlugin } from "@platejs/link/react";
import { KEYS, type TLinkElement } from "platejs";
import type { useEditorRef } from "platejs/react";

type DocLinkEditor = ReturnType<typeof useEditorRef>;

export function applyLinkUrl(
  editor: DocLinkEditor,
  url: string,
  title?: string,
) {
  const entry = editor.api.node<TLinkElement>({
    match: { type: editor.getType(KEYS.link) },
  });
  if (entry) {
    const [, path] = entry;
    editor.tf.setNodes({ url }, { at: path });
  } else {
    upsertLink(editor, {
      url,
      text: title,
      skipValidation: true,
    });
  }
  editor.getApi(LinkPlugin).floatingLink.hide();
  editor.tf.focus();
}
