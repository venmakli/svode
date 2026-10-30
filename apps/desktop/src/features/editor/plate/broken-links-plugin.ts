import { createPlatePlugin } from "platejs/react";

/**
 * Link targets that validate_links reported missing for this editor's
 * document (DF-245). Plugin options live per editor, so a load, validation or
 * unmount in another editor never touches them, and an editor that does not
 * validate its links (the Routine field) marks none.
 */
export const BrokenLinksPlugin = createPlatePlugin({
  key: "brokenLinks",
  options: { brokenLinks: new Set<string>() as ReadonlySet<string> },
});
