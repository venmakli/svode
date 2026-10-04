import { expect, test } from "bun:test";
import type { AgentQuestionFieldDto } from "@/platform/agent-runtime/agent-runtime-api";
import { questionItems, questionValues } from "./question-form";

const fields: AgentQuestionFieldDto[] = [
  {
    id: "target",
    title: "Which branch?",
    description: null,
    required: true,
    input: {
      type: "single_choice",
      options: [
        { id: "main", label: "main", description: null },
        { id: "dev", label: "dev", description: "Integration" },
      ],
      default: null,
    },
  },
  {
    id: "note",
    title: "Note",
    description: null,
    required: false,
    input: {
      type: "text",
      default: null,
      minLength: null,
      maxLength: 20,
      format: null,
      pattern: null,
    },
  },
  {
    id: "force",
    title: "Force push?",
    description: null,
    required: true,
    input: { type: "boolean", default: false },
  },
  {
    id: "count",
    title: "How many?",
    description: null,
    required: false,
    input: { type: "integer", default: null, minimum: 1, maximum: 9 },
  },
];

test("each field is one step, booleans choose yes or no", () => {
  expect(questionItems(fields)).toEqual([
    {
      name: "target",
      required: true,
      choices: [{ value: "main" }, { value: "dev" }],
    },
    { name: "note", required: false },
    {
      name: "force",
      required: true,
      choices: [{ value: "true" }, { value: "false" }],
    },
    { name: "count", required: false },
  ]);
});

test("submitted values take the agent's types and empty optional fields stay out", () => {
  const form = new FormData();
  form.set("target", "dev");
  form.set("note", "");
  form.set("force", "false");
  form.set("count", "3");
  expect(questionValues(fields, form)).toEqual({
    target: "dev",
    force: false,
    count: 3,
  });
});
