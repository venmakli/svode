import { listen } from "@/platform/native/events";
import { reindexProject } from "@/platform/space/space-api";

export interface EditorFileEvent {
  path: string;
  writeNonce?: string;
}

type EditorFileEventHandler = (event: EditorFileEvent) => void;

export function listenToEditorFileChanged(handler: EditorFileEventHandler) {
  return listen<EditorFileEvent>("file:changed", (event) =>
    handler(event.payload),
  );
}

export function listenToEditorFileDeleted(handler: EditorFileEventHandler) {
  return listen<EditorFileEvent>("file:deleted", (event) =>
    handler(event.payload),
  );
}

export function listenToEditorFileCreated(handler: EditorFileEventHandler) {
  return listen<EditorFileEvent>("file:created", (event) =>
    handler(event.payload),
  );
}

export function reindexEditorProject(projectPath: string): Promise<void> {
  return reindexProject(projectPath);
}
