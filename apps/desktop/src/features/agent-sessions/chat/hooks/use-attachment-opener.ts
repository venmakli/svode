import { createContext, useContext } from "react";
import type { Attachment } from "../model/attachments";

/**
 * Opens an attachment badge (Stage 10 `04`, preview and opening): the app
 * shell decides how — a peek over the chat for a page or a file of the
 * project, the system app for anything else.
 */
export type OpenAttachment = (attachment: Attachment) => void;

export const AttachmentOpenerContext = createContext<OpenAttachment | null>(
  null,
);

export function useOpenAttachment(): OpenAttachment | null {
  return useContext(AttachmentOpenerContext);
}
