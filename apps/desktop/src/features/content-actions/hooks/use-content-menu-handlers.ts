import { useRef } from "react";
import { CONTENT_ACTION_PRESENTATION } from "../ui/content-action-presentation";
import type { ContentActionHandlers } from "../ui/content-action-menu-items";

/**
 * The handlers of a content menu and the `onCloseAutoFocus` of its content.
 * An action that moves focus to a name field runs once the menu has closed,
 * instead of the menu's focus trap taking the focus back and handing it to
 * the trigger. Other actions run on select, and a menu closed without one
 * returns focus to its trigger.
 */
export function useContentMenuHandlers(handlers: ContentActionHandlers): {
  handlers: ContentActionHandlers;
  onCloseAutoFocus: (event: Event) => void;
} {
  const afterCloseRef = useRef<(() => void) | null>(null);
  const shown: ContentActionHandlers = { ...handlers };
  for (const id of Object.keys(handlers) as (keyof ContentActionHandlers)[]) {
    const handler = handlers[id];
    if (handler && CONTENT_ACTION_PRESENTATION[id].focusesNameField) {
      shown[id] = () => {
        afterCloseRef.current = handler;
      };
    }
  }

  return {
    handlers: shown,
    onCloseAutoFocus: (event) => {
      const afterClose = afterCloseRef.current;
      if (!afterClose) return;
      afterCloseRef.current = null;
      event.preventDefault();
      afterClose();
    },
  };
}
