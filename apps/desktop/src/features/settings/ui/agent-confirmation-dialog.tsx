import { useId, useState, type ReactNode } from "react";
import * as m from "@/paraglide/messages.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import type { AgentSetupDto } from "../api";
import { enableInstallsAdapter } from "../model/agent-row";
import type {
  IntegrationKit,
  IntegrationPart,
  OwnPartRemoval,
  ToolsOffer,
} from "../model/svode-integration";

export type AgentConfirmation =
  | { kind: "enable"; setup: AgentSetupDto; tools: ToolsOffer | null }
  | { kind: "disable"; setup: AgentSetupDto; removal: OwnPartRemoval }
  | { kind: "remove"; setup: AgentSetupDto };

/** What the user chose in the confirmation. */
export interface AgentConfirmationChoice {
  addTools: boolean;
  removePart: boolean;
  removeShared: boolean;
}

function toolsText(kit: IntegrationKit, agent: string) {
  switch (kit) {
    case "plugin":
      return m.settings_agents_enable_tools_plugin();
    case "mcp_shared":
      return m.settings_agents_enable_tools_mcp_shared({ agent });
    case "mcp":
      return m.settings_agents_enable_tools_mcp({ agent });
    case "shared_skill":
      return m.settings_agents_enable_tools_shared_skill({ agent });
  }
}

function removalTitle(part: IntegrationPart) {
  switch (part) {
    case "plugin":
      return m.settings_agents_disable_remove_plugin();
    case "mcp":
      return m.settings_agents_disable_remove_mcp();
    case "skills":
      return m.settings_agents_disable_remove_skills();
  }
}

function removalDescription(part: IntegrationPart, agent: string) {
  switch (part) {
    case "plugin":
      return m.settings_agents_disable_remove_plugin_description({ agent });
    case "mcp":
      return m.settings_agents_disable_remove_mcp_description({ agent });
    case "skills":
      return m.settings_agents_disable_remove_skills_description({ agent });
  }
}

function OptionField({
  id,
  checked,
  onCheckedChange,
  title,
  children,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Field orientation="horizontal" data-confirmation-option={id}>
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <FieldContent>
        <FieldLabel htmlFor={id}>{title}</FieldLabel>
        <FieldDescription className="flex flex-col gap-1">
          {children}
        </FieldDescription>
      </FieldContent>
    </Field>
  );
}

/**
 * Turning an agent on when it installs an adapter or can get Svode tools,
 * turning it off when Svode can remove its own part, and removing the
 * adapter. Turning on and adding tools are independent results.
 */
export function AgentConfirmationDialog({
  confirmation,
  open,
  onOpenChange,
  label,
  names,
  onConfirm,
}: {
  confirmation: AgentConfirmation | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: (agent: string) => string;
  names: (agents: string[]) => string;
  onConfirm: (
    confirmation: AgentConfirmation,
    choice: AgentConfirmationChoice,
  ) => void;
}) {
  const idPrefix = useId();
  // The choice starts over with each confirmation.
  const [choice, setChoice] = useState<{
    of: AgentConfirmation | null;
    value: AgentConfirmationChoice;
  }>({ of: null, value: defaultChoice() });
  const value = choice.of === confirmation ? choice.value : defaultChoice();
  const update = (next: Partial<AgentConfirmationChoice>) =>
    setChoice({ of: confirmation, value: { ...value, ...next } });

  const setup = confirmation?.setup;
  const agent = setup ? label(setup.agent) : "";
  const adapter = setup?.adapter;

  const title = () => {
    switch (confirmation?.kind) {
      case "enable":
        return m.settings_agents_enable_title({ agent });
      case "disable":
        return m.settings_agents_disable_title({ agent });
      case "remove":
        return m.settings_agents_remove_title({ agent });
      default:
        return "";
    }
  };

  const description = () => {
    switch (confirmation?.kind) {
      case "enable":
        return setup && enableInstallsAdapter(setup)
          ? m.settings_agents_enable_description({
              agent,
              package: adapter?.package ?? "",
              version: adapter?.pinnedVersion ?? "",
            })
          : m.settings_agents_enable_available({ agent });
      case "disable":
        return m.settings_agents_disable_description({ agent });
      case "remove":
        return m.settings_agents_remove_description({ agent });
      default:
        return "";
    }
  };

  const tools = confirmation?.kind === "enable" ? confirmation.tools : null;
  const removal =
    confirmation?.kind === "disable" ? confirmation.removal : null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        {confirmation ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{title()}</AlertDialogTitle>
              <AlertDialogDescription>{description()}</AlertDialogDescription>
            </AlertDialogHeader>
            {tools ? (
              <FieldGroup>
                <OptionField
                  id={`${idPrefix}-tools`}
                  checked={value.addTools}
                  onCheckedChange={(addTools) => update({ addTools })}
                  title={m.settings_agents_enable_tools()}
                >
                  <span>
                    {toolsText(tools.kit, agent)}
                    {tools.sharedReused
                      ? ` ${m.settings_agents_enable_tools_shared_reused()}`
                      : null}
                    {tools.alsoReaders.length
                      ? ` ${m.settings_agents_enable_tools_shared_readers({
                          agents: names(tools.alsoReaders),
                        })}`
                      : null}
                  </span>
                  {tools.limitation ? <span>{tools.limitation}</span> : null}
                  <span>{m.settings_agents_enable_tools_pii({ agent })}</span>
                </OptionField>
              </FieldGroup>
            ) : null}
            {removal ? (
              <FieldGroup>
                <OptionField
                  id={`${idPrefix}-part`}
                  checked={value.removePart}
                  onCheckedChange={(removePart) =>
                    update({
                      removePart,
                      removeShared: removePart && value.removeShared,
                    })
                  }
                  title={removalTitle(removal.part)}
                >
                  {removalDescription(removal.part, agent)}
                </OptionField>
                {removal.sharedRemovable && value.removePart ? (
                  <OptionField
                    id={`${idPrefix}-shared`}
                    checked={value.removeShared}
                    onCheckedChange={(removeShared) => update({ removeShared })}
                    title={m.settings_agents_disable_remove_shared()}
                  >
                    {m.settings_agents_disable_remove_shared_description()}
                  </OptionField>
                ) : null}
              </FieldGroup>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel>{m.project_cancel()}</AlertDialogCancel>
              <AlertDialogAction
                variant={
                  confirmation.kind === "remove" ? "destructive" : undefined
                }
                onClick={() => onConfirm(confirmation, value)}
              >
                {confirmation.kind === "enable"
                  ? m.settings_agents_enable_action()
                  : confirmation.kind === "disable"
                    ? m.settings_agents_disable_action()
                    : m.settings_agents_remove_adapter()}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        ) : null}
      </AlertDialogContent>
    </AlertDialog>
  );
}

function defaultChoice(): AgentConfirmationChoice {
  return { addTools: true, removePart: false, removeShared: false };
}
