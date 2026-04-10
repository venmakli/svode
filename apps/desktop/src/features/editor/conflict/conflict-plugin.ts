import { createPlatePlugin } from "platejs/react";
import { ConflictElementComponent } from "./conflict-element";

/**
 * Plate plugin that renders git merge-conflict markers as a custom block.
 *
 * Parsing is done in the editor load path (see `deserializeWithConflicts`).
 * This plugin only owns the element type + render component.
 */
export const ConflictPlugin = createPlatePlugin({
  key: "conflict",
  node: {
    isElement: true,
    isVoid: true,
    type: "conflict",
    component: ConflictElementComponent,
  },
});
