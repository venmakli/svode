import type {
  CollectionActionState,
  CollectionCreateCapability,
} from "@/features/collection";
import * as m from "@/paraglide/messages.js";

export function createAttachmentsCreateCapability({
  hasDirectCollection,
  onCreatePage,
  onImportFile,
  state,
}: {
  hasDirectCollection: boolean;
  onCreatePage(): void | Promise<void>;
  onImportFile(): void | Promise<void>;
  state: CollectionActionState;
}): CollectionCreateCapability {
  return {
    intents: [
      ...(hasDirectCollection
        ? []
        : [
            {
              getState: () => state,
              id: "new-page",
              label: m.attachments_new_page(),
              run: onCreatePage,
            },
          ]),
      {
        getState: () => state,
        id: "import-file",
        label: m.attachments_import_file(),
        run: onImportFile,
      },
    ],
    label: m.attachments_add(),
  };
}
