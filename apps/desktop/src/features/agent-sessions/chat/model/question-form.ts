import type { AgentQuestionFieldDto } from "@/platform/agent-runtime/agent-runtime-api";

export type QuestionValue = boolean | number | string | string[];

/** The choices of a field: its options, or yes/no for a boolean field. */
export function fieldChoices(field: AgentQuestionFieldDto): string[] | null {
  switch (field.input.type) {
    case "single_choice":
    case "multiple_choice":
      return field.input.options.map((option) => option.id);
    case "boolean":
      return ["true", "false"];
    default:
      return null;
  }
}

/** The questionnaire steps of an agent's question, one per field. */
export function questionItems(fields: readonly AgentQuestionFieldDto[]) {
  return fields.map((field) => {
    const choices = fieldChoices(field);
    return {
      name: field.id,
      required: field.required,
      ...(choices ? { choices: choices.map((value) => ({ value })) } : {}),
    };
  });
}

/**
 * The answer values of a submitted form in the agent's types; an empty
 * optional field is left out. The runtime checks them against the
 * declared bounds.
 */
export function questionValues(
  fields: readonly AgentQuestionFieldDto[],
  form: Pick<FormData, "get" | "getAll">,
): Record<string, QuestionValue> {
  const values: Record<string, QuestionValue> = {};
  for (const field of fields) {
    if (field.input.type === "multiple_choice") {
      const chosen = form.getAll(field.id).map(String);
      if (chosen.length > 0 || field.required) values[field.id] = chosen;
      continue;
    }
    const raw = form.get(field.id);
    if (raw === null || String(raw) === "") continue;
    const text = String(raw);
    switch (field.input.type) {
      case "boolean":
        values[field.id] = text === "true";
        break;
      case "number":
        values[field.id] = Number(text);
        break;
      case "integer":
        values[field.id] = Math.trunc(Number(text));
        break;
      default:
        values[field.id] = text;
    }
  }
  return values;
}
