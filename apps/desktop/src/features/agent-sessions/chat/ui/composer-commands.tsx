import { useState } from "react";
import { SlashInputPlugin, SlashPlugin } from "@platejs/slash-command/react";
import { KEYS, type TComboboxInputElement } from "platejs";
import {
  createPlatePlugin,
  PlateElement,
  usePluginOption,
  type PlateEditor,
  type PlateElementProps,
} from "platejs/react";
import {
  InlineCombobox,
  InlineComboboxContent,
  InlineComboboxEmpty,
  InlineComboboxGroup,
  InlineComboboxInput,
  InlineComboboxItem,
} from "@/components/ui/inline-combobox";
import type { AgentSessionCommandDto } from "../api/chat";
import * as m from "@/paraglide/messages.js";

/** The slash commands the agent offers in this session, set by the composer. */
export const SessionCommandsPlugin = createPlatePlugin({
  key: "session_commands",
  options: { commands: [] as AgentSessionCommandDto[] },
});

/**
 * `/` opens the agent's commands (`04` composer) only when the agent
 * declared some; otherwise `/` is a plain character.
 */
export const COMMAND_PLUGINS = [
  SessionCommandsPlugin,
  SlashPlugin.configure({
    options: {
      triggerQuery: (editor) =>
        editor.getOption(SessionCommandsPlugin, "commands").length > 0,
    },
  }),
  SlashInputPlugin.withComponent(CommandSearchElement),
];

/** Opens the command search at the cursor, as typing `/` does. */
export function startCommand(editor: PlateEditor) {
  // The search input takes focus itself, as in `startMention`.
  if (!editor.selection) editor.tf.select(editor.api.end([]));
  editor.tf.insertNodes({
    type: KEYS.slashInput,
    trigger: "/",
    children: [{ text: "" }],
  });
}

/**
 * The search of the agent's commands. A chosen command goes into the text
 * and reaches the agent as an ordinary prompt.
 */
function CommandSearchElement(props: PlateElementProps<TComboboxInputElement>) {
  const { editor, element } = props;
  const commands = usePluginOption(SessionCommandsPlugin, "commands");
  const [query, setQuery] = useState("");
  return (
    <PlateElement {...props} as="span">
      <InlineCombobox
        element={element}
        trigger="/"
        value={query}
        setValue={setQuery}
      >
        <InlineComboboxInput
          aria-label={m.sessions_chat_command_search()}
          className="placeholder:text-muted-foreground"
        />
        <InlineComboboxContent>
          <InlineComboboxEmpty>
            {m.sessions_chat_command_empty()}
          </InlineComboboxEmpty>
          <InlineComboboxGroup>
            {commands.map((command) => (
              <InlineComboboxItem
                key={command.name}
                value={command.name}
                keywords={[command.description]}
                label={command.name}
                className="h-auto min-h-[38px] items-center py-1"
                onClick={() => editor.tf.insertText(`/${command.name} `)}
              >
                <span className="flex min-w-0 flex-1 flex-col justify-center leading-none">
                  <span className="truncate text-sm leading-4">
                    /{command.name}
                  </span>
                  {(command.description || command.hint) && (
                    <span className="truncate text-[11px] leading-3 text-muted-foreground">
                      {[
                        command.description,
                        command.hint && `‹${command.hint}›`,
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    </span>
                  )}
                </span>
              </InlineComboboxItem>
            ))}
          </InlineComboboxGroup>
        </InlineComboboxContent>
      </InlineCombobox>
      {props.children}
    </PlateElement>
  );
}
