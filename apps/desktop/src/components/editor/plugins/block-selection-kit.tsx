"use client";

import { AIChatPlugin } from "@platejs/ai/react";
import { BlockSelectionPlugin } from "@platejs/selection/react";
import { getPluginTypes, isHotkey, KEYS } from "platejs";

// eslint-disable-next-line svode/import-boundaries -- Read-only Plate feature flags stay in copied kit until editor-owned kit options replace direct config reads.
import { ENABLE_PLATE_AI } from "@/app/config/feature-flags";
import { BlockSelection } from "@/components/ui/block-selection";

export const BlockSelectionKit = [
  BlockSelectionPlugin.configure(({ editor }) => ({
    options: {
      enableContextMenu: true,
      isSelectable: (element) =>
        !getPluginTypes(editor, [KEYS.column, KEYS.codeLine, KEYS.td]).includes(
          element.type,
        ),
      onKeyDownSelecting: (editor, e) => {
        if (ENABLE_PLATE_AI && isHotkey("mod+j")(e)) {
          editor.getApi(AIChatPlugin).aiChat.show();
        }
      },
    },
    render: {
      belowRootNodes: (props) => {
        if (!props.attributes.className?.includes("slate-selectable"))
          return null;

        return <BlockSelection {...(props as any)} />;
      },
    },
  })),
];
