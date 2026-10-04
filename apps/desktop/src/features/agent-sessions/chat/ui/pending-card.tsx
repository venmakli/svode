import { useEffect, useRef, type ReactNode } from "react";
import { Square } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  AgentInteractionAnswerDto,
  AgentPendingInteractionDto,
  AgentQuestionFieldDto,
  AgentSessionKeyDto,
} from "../api/chat";
import { questionItems, questionValues } from "../model/question-form";
import { ItemDetail } from "./item-detail";
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
  return (
    <>
      <h3 className="text-sm font-medium break-words">{pending.title}</h3>
      {toolCall?.hasDetail && (
        <div className="min-h-0 overflow-y-auto">
          <ItemDetail session={session} item={toolCall} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {pending.options.map((option, index) => (
          <Button
            key={option.id}
            type="button"
            size="sm"
            variant={
              index === 0
                ? "default"
                : option.kind.startsWith("reject")
                  ? "outline"
                  : "secondary"
            }
            disabled={disabled}
            onClick={() => onAnswer({ type: "option", optionId: option.id })}
          >
            {option.label}
          </Button>
        ))}
        <span className="ms-auto">{stop}</span>
      </div>
    </>
  );
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
      <p className="text-sm break-words whitespace-pre-wrap">{pending.title}</p>
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
          <QuestionnaireNext size="sm">
            {m.sessions_chat_question_next()}
          </QuestionnaireNext>
          <QuestionnaireSubmit size="sm">
            {m.sessions_chat_question_submit()}
          </QuestionnaireSubmit>
        </QuestionnaireActions>
      </Questionnaire>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onAnswer({ type: "decline" })}
        >
          {m.sessions_chat_question_decline()}
        </Button>
        <span className="ms-auto">{stop}</span>
      </div>
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
