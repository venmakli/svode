import { useEffect, useRef, type ReactNode } from "react";
import { Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarkdownReader } from "@/shared/ui/markdown-reader";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire";
import type {
  AgentActivityItemDto,
  AgentDetailBlockDto,
  AgentInteractionAnswerDto,
  AgentPendingInteractionDto,
  AgentQuestionFieldDto,
  AgentSessionKeyDto,
  AgentToolKindDto,
} from "../api/chat";
import { useItemDetail } from "../hooks/use-item-detail";
import { questionItems, questionValues } from "../model/question-form";
import { agentTextPolicy } from "./chat-timeline";
import { DetailBlock, DetailView } from "./item-detail";
import * as m from "@/paraglide/messages.js";

/**
 * The agent's current request in place of the composer field (Stage 10
 * `04`, pending interaction): its subject, exactly the options or fields
 * the agent sent, and stop. Appearing never answers: focus moves to the
 * card itself, not to an option, when it was in the field.
 */
export function PendingCard({
  session,
  pending,
  toolCall,
  takeFocus,
  cancelling,
  error,
  onAnswer,
  onStop,
}: {
  session: AgentSessionKeyDto;
  pending: AgentPendingInteractionDto;
  /** The timeline item of the tool call a permission is for. */
  toolCall: AgentActivityItemDto | null;
  /** Focus was in the composer field the card replaces. */
  takeFocus: boolean;
  cancelling: boolean;
  error: string | null;
  onAnswer: (answer: AgentInteractionAnswerDto) => void;
  onStop: () => void;
}) {
  const cardRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (takeFocus) cardRef.current?.focus({ preventScroll: true });
    // Only the card's appearance moves focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.id]);

  const stop = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="-me-1.5 -mt-1 shrink-0"
      disabled={cancelling}
      onClick={onStop}
    >
      <Square data-icon="inline-start" />
      {cancelling ? m.sessions_chat_stopping() : m.sessions_chat_stop()}
    </Button>
  );

  return (
    <section
      ref={cardRef}
      tabIndex={-1}
      role="region"
      aria-live="polite"
      aria-label={
        pending.kind === "permission"
          ? m.sessions_chat_request_permission()
          : m.sessions_chat_request_question()
      }
      className="flex max-h-[60vh] flex-col gap-3 rounded-xl border bg-background p-3 shadow-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {pending.kind === "permission" ? (
        <PermissionContent
          session={session}
          pending={pending}
          toolCall={toolCall}
          disabled={cancelling}
          onAnswer={onAnswer}
          stop={stop}
        />
      ) : (
        <QuestionContent
          pending={pending}
          disabled={cancelling}
          onAnswer={onAnswer}
          stop={stop}
        />
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}

function PermissionContent({
  session,
  pending,
  toolCall,
  disabled,
  onAnswer,
  stop,
}: {
  session: AgentSessionKeyDto;
  pending: AgentPendingInteractionDto;
  toolCall: AgentActivityItemDto | null;
  disabled: boolean;
  onAnswer: (answer: AgentInteractionAnswerDto) => void;
  stop: ReactNode;
}) {
  const tool = toolCall?.kind === "tool_call" ? toolCall.tool : null;
  return (
    <>
      <CardHeading stop={stop}>{requestHeading(tool)}</CardHeading>
      {toolCall?.kind === "tool_call" ? (
        <RequestSubject session={session} item={toolCall} />
      ) : (
        pending.title && <p className="text-sm break-words">{pending.title}</p>
      )}
      <div className="flex shrink-0 flex-col gap-1.5">
        {pending.options.map((option) => (
          <Button
            key={option.id}
            type="button"
            variant="outline"
            className="h-auto min-h-8 justify-start py-1.5 text-start whitespace-normal"
            disabled={disabled}
            onClick={() => onAnswer({ type: "option", optionId: option.id })}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </>
  );
}

function CardHeading({ stop, children }: { stop: ReactNode; children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-start gap-2">
      <h3 className="min-w-0 flex-1 text-sm font-medium break-words whitespace-pre-wrap">
        {children}
      </h3>
      {stop}
    </div>
  );
}

/** The request as a question, by what the tool call does. */
function requestHeading(tool: AgentToolKindDto | null): string {
  switch (tool) {
    case "execute":
      return m.sessions_chat_request_heading_execute();
    case "edit":
      return m.sessions_chat_request_heading_edit();
    case "delete":
      return m.sessions_chat_request_heading_delete();
    case "move":
      return m.sessions_chat_request_heading_move();
    case "read":
      return m.sessions_chat_request_heading_read();
    case "search":
      return m.sessions_chat_request_heading_search();
    case "fetch":
      return m.sessions_chat_request_heading_fetch();
    // Claude Code and Codex ask to approve a plan as a mode switch.
    case "switch_mode":
      return m.sessions_chat_request_heading_plan();
    default:
      return m.sessions_chat_request_heading_other();
  }
}

/**
 * What the request is about: the tool call as the agent names it (the
 * command, the edited file) and its content (a description, the diff,
 * the plan text), in a bounded region of its own.
 */
function RequestSubject({
  session,
  item,
}: {
  session: AgentSessionKeyDto;
  item: Extract<AgentActivityItemDto, { kind: "tool_call" }>;
}) {
  const detail = useItemDetail(session, item, item.hasDetail);
  // A plan approval names only the request, which the heading says.
  const title = item.tool === "switch_mode" ? "" : item.summary;
  if (!title && !item.hasDetail) return null;
  return (
    <div
      tabIndex={0}
      className="flex max-h-72 min-h-0 flex-col gap-2 overflow-y-auto rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {title &&
        (item.tool === "execute" ? (
          <pre className="rounded-md bg-muted/60 px-3 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
            {commandText(title)}
          </pre>
        ) : (
          <p className="text-sm break-words">{title}</p>
        ))}
      {item.hasDetail &&
        (detail?.outcome === "available" ? (
          detail.blocks.map((block, index) =>
            block.type === "text" || block.type === "excerpt" ? (
              <SubjectText
                key={index}
                text={block.type === "text" ? block.text : excerptText(block)}
                markdown={item.tool === "switch_mode"}
              />
            ) : (
              <DetailBlock key={index} block={block} />
            ),
          )
        ) : (
          <DetailView detail={detail} />
        ))}
    </div>
  );
}

function SubjectText({ text, markdown }: { text: string; markdown: boolean }) {
  if (markdown) {
    return (
      <div className="text-sm">
        <MarkdownReader content={text} policy={agentTextPolicy} />
      </div>
    );
  }
  return (
    <p className="text-sm break-words whitespace-pre-wrap text-muted-foreground">
      {text}
    </p>
  );
}

/** A command title without the code marks an agent wraps it in. */
function commandText(title: string): string {
  const match = /^`([^`]+)`$/.exec(title.trim());
  return match ? match[1] : title;
}

function excerptText(block: Extract<AgentDetailBlockDto, { type: "excerpt" }>) {
  return `${block.head}\n\n${m.sessions_chat_detail_omitted({
    count: block.omittedChars.toLocaleString(),
  })}\n\n${block.tail}`;
}

function QuestionContent({
  pending,
  disabled,
  onAnswer,
  stop,
}: {
  pending: AgentPendingInteractionDto;
  disabled: boolean;
  onAnswer: (answer: AgentInteractionAnswerDto) => void;
  stop: ReactNode;
}) {
  const fields = pending.fields;
  return (
    <>
      <CardHeading stop={stop}>{pending.title}</CardHeading>
      <Questionnaire
        className="min-h-0 overflow-y-auto"
        items={questionItems(fields)}
        defaultItem={fields[0]?.id}
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled) return;
          onAnswer({
            type: "form",
            values: questionValues(fields, new FormData(event.currentTarget)),
          });
        }}
      >
        {fields.length > 1 && <QuestionnaireProgress />}
        {fields.map((field) => (
          <QuestionField key={field.id} field={field} />
        ))}
        <QuestionnaireActions>
          <QuestionnairePrevious size="sm">
            {m.sessions_chat_question_previous()}
          </QuestionnairePrevious>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="col-start-2 row-start-1 justify-self-end"
            disabled={disabled}
            onClick={() => onAnswer({ type: "decline" })}
          >
            {m.sessions_chat_question_decline()}
          </Button>
          <QuestionnaireNext size="sm">
            {m.sessions_chat_question_next()}
          </QuestionnaireNext>
          <QuestionnaireSubmit size="sm">
            {m.sessions_chat_question_submit()}
          </QuestionnaireSubmit>
        </QuestionnaireActions>
      </Questionnaire>
    </>
  );
}

function QuestionField({ field }: { field: AgentQuestionFieldDto }) {
  const input = field.input;
  return (
    <QuestionnaireItem
      name={field.id}
      required={field.required}
      multiple={input.type === "multiple_choice"}
    >
      <QuestionnaireTitle className="text-sm">{field.title}</QuestionnaireTitle>
      {field.description && (
        <QuestionnaireDescription>{field.description}</QuestionnaireDescription>
      )}
      {input.type === "single_choice" || input.type === "multiple_choice" ? (
        <QuestionnaireChoices>
          {input.options.map((option) => (
            <QuestionnaireChoice
              key={option.id}
              value={option.id}
              defaultChecked={
                input.type === "single_choice"
                  ? input.default === option.id
                  : input.default.includes(option.id)
              }
            >
              <span>{option.label}</span>
              {option.description && (
                <QuestionnaireChoiceDescription>
                  {option.description}
                </QuestionnaireChoiceDescription>
              )}
            </QuestionnaireChoice>
          ))}
        </QuestionnaireChoices>
      ) : input.type === "boolean" ? (
        <QuestionnaireChoices>
          <QuestionnaireChoice value="true" defaultChecked={input.default === true}>
            {m.sessions_chat_question_yes()}
          </QuestionnaireChoice>
          <QuestionnaireChoice value="false" defaultChecked={input.default === false}>
            {m.sessions_chat_question_no()}
          </QuestionnaireChoice>
        </QuestionnaireChoices>
      ) : input.type === "text" ? (
        <QuestionnaireInput
          aria-label={field.title}
          defaultValue={input.default ?? undefined}
          minLength={input.minLength ?? undefined}
          maxLength={input.maxLength ?? undefined}
        />
      ) : (
        <QuestionnaireInput
          aria-label={field.title}
          type="number"
          step={input.type === "integer" ? 1 : "any"}
          defaultValue={input.default ?? undefined}
          min={input.minimum ?? undefined}
          max={input.maximum ?? undefined}
        />
      )}
      <QuestionnaireError />
    </QuestionnaireItem>
  );
}
