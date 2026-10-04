//! Answers to pending interactions (Stage 10 `02` C6): what a consumer may
//! send and how the runtime checks it against what the agent declared.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::activity::{FieldInput, InteractionState, PendingInteraction, QuestionField};
use crate::status::InteractionKind;

/// A value of one question field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FieldValue {
    Boolean(bool),
    Integer(i64),
    Number(f64),
    Text(String),
    Choices(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum InteractionAnswer {
    /// One of the options of a permission request.
    Option { option_id: String },
    /// Values of question fields by field id.
    Form {
        values: BTreeMap<String, FieldValue>,
    },
    /// The user declines to answer a question.
    Decline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "outcome",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AnswerOutcome {
    /// The answer went to the agent; the interaction is `answered`.
    Accepted,
    /// The interaction is not pending: already resolved (its state), or not
    /// an interaction of this session (`None`). Nothing was sent.
    NotPending { state: Option<InteractionState> },
}

/// Checks an answer against the pending interaction it addresses.
pub(crate) fn validate(
    pending: &PendingInteraction,
    answer: &InteractionAnswer,
) -> Result<(), String> {
    match (pending.kind, answer) {
        (InteractionKind::Permission, InteractionAnswer::Option { option_id }) => {
            if pending.options.iter().any(|option| &option.id == option_id) {
                Ok(())
            } else {
                Err(format!("{option_id} is not an option of this request"))
            }
        }
        (InteractionKind::Question, InteractionAnswer::Form { values }) => {
            if let Some(id) = values
                .keys()
                .find(|id| !pending.fields.iter().any(|field| &field.id == *id))
            {
                return Err(format!("{id} is not a field of this question"));
            }
            for field in &pending.fields {
                match values.get(&field.id) {
                    Some(value) => validate_field(field, value)?,
                    None if field.required => return Err(format!("{} is required", field.id)),
                    None => {}
                }
            }
            Ok(())
        }
        (InteractionKind::Question, InteractionAnswer::Decline) => Ok(()),
        (InteractionKind::Permission, _) => Err("a permission is answered with an option".into()),
        (InteractionKind::Question, _) => {
            Err("a question is answered with field values or declined".into())
        }
    }
}

fn validate_field(field: &QuestionField, value: &FieldValue) -> Result<(), String> {
    let id = &field.id;
    let within = |ok: bool, bound: &str| {
        if ok {
            Ok(())
        } else {
            Err(format!("{id} is out of its bounds: {bound}"))
        }
    };
    match (&field.input, value) {
        (
            FieldInput::Text {
                min_length,
                max_length,
                ..
            },
            FieldValue::Text(text),
        ) => {
            let length = text.chars().count() as u64;
            within(
                min_length.is_none_or(|min| length >= u64::from(min))
                    && max_length.is_none_or(|max| length <= u64::from(max)),
                "length",
            )
        }
        (
            FieldInput::Number {
                minimum, maximum, ..
            },
            FieldValue::Number(number),
        ) => within(in_range(*number, *minimum, *maximum), "range"),
        // JSON does not tell 3 from 3.0; an integer is a valid number.
        (
            FieldInput::Number {
                minimum, maximum, ..
            },
            FieldValue::Integer(number),
        ) => within(in_range(*number as f64, *minimum, *maximum), "range"),
        (
            FieldInput::Integer {
                minimum, maximum, ..
            },
            FieldValue::Integer(number),
        ) => within(in_range(*number, *minimum, *maximum), "range"),
        (FieldInput::Boolean { .. }, FieldValue::Boolean(_)) => Ok(()),
        (FieldInput::SingleChoice { options, .. }, FieldValue::Text(choice)) => {
            within(options.iter().any(|option| &option.id == choice), "options")
        }
        (
            FieldInput::MultipleChoice {
                options,
                min_items,
                max_items,
                ..
            },
            FieldValue::Choices(choices),
        ) => {
            let count = choices.len() as u64;
            within(
                choices
                    .iter()
                    .all(|choice| options.iter().any(|option| &option.id == choice)),
                "options",
            )?;
            within(
                min_items.is_none_or(|min| count >= min)
                    && max_items.is_none_or(|max| count <= max),
                "number of choices",
            )
        }
        _ => Err(format!("{id} has a value of another type")),
    }
}

fn in_range<T: PartialOrd>(value: T, minimum: Option<T>, maximum: Option<T>) -> bool {
    minimum.is_none_or(|min| value >= min) && maximum.is_none_or(|max| value <= max)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity::{ChoiceOption, InteractionOption, InteractionOptionKind};

    fn question(fields: Vec<QuestionField>) -> PendingInteraction {
        PendingInteraction {
            id: "interaction:1".into(),
            kind: InteractionKind::Question,
            title: "Codex needs your input".into(),
            tool_call_id: None,
            options: Vec::new(),
            fields,
            state: InteractionState::Pending,
        }
    }

    fn field(id: &str, required: bool, input: FieldInput) -> QuestionField {
        QuestionField {
            id: id.into(),
            title: id.into(),
            description: None,
            required,
            input,
        }
    }

    fn choice(id: &str) -> ChoiceOption {
        ChoiceOption {
            id: id.into(),
            label: id.into(),
            description: None,
        }
    }

    fn form(values: &[(&str, FieldValue)]) -> InteractionAnswer {
        InteractionAnswer::Form {
            values: values
                .iter()
                .map(|(id, value)| (id.to_string(), value.clone()))
                .collect(),
        }
    }

    #[test]
    fn a_permission_takes_one_of_its_options() {
        let pending = PendingInteraction {
            options: vec![InteractionOption {
                id: "allow".into(),
                label: "Allow".into(),
                kind: InteractionOptionKind::AllowOnce,
            }],
            kind: InteractionKind::Permission,
            ..question(Vec::new())
        };
        let answer = |id: &str| InteractionAnswer::Option {
            option_id: id.into(),
        };
        assert!(validate(&pending, &answer("allow")).is_ok());
        assert!(validate(&pending, &answer("other")).is_err());
        assert!(validate(&pending, &InteractionAnswer::Decline).is_err());
    }

    #[test]
    fn a_question_takes_declared_fields_of_their_type_within_bounds() {
        let pending = question(vec![
            field(
                "strategy",
                true,
                FieldInput::SingleChoice {
                    options: vec![choice("safe"), choice("bold")],
                    default: None,
                },
            ),
            field(
                "note",
                false,
                FieldInput::Text {
                    default: None,
                    min_length: None,
                    max_length: Some(3),
                    format: None,
                    pattern: None,
                },
            ),
            field(
                "port",
                false,
                FieldInput::Integer {
                    default: None,
                    minimum: Some(1024),
                    maximum: None,
                },
            ),
            field(
                "tags",
                false,
                FieldInput::MultipleChoice {
                    options: vec![choice("a"), choice("b")],
                    default: Vec::new(),
                    min_items: Some(1),
                    max_items: None,
                },
            ),
        ]);
        let text = |text: &str| FieldValue::Text(text.into());
        assert!(validate(&pending, &form(&[("strategy", text("safe"))])).is_ok());
        assert!(
            validate(
                &pending,
                &form(&[
                    ("strategy", text("bold")),
                    ("note", text("ок!")),
                    ("port", FieldValue::Integer(8080)),
                    ("tags", FieldValue::Choices(vec!["a".into(), "b".into()])),
                ])
            )
            .is_ok()
        );
        assert!(validate(&pending, &InteractionAnswer::Decline).is_ok());

        let rejected = [
            form(&[]),
            form(&[("strategy", text("other"))]),
            form(&[("strategy", text("safe")), ("extra", text("x"))]),
            form(&[("strategy", text("safe")), ("note", text("long"))]),
            form(&[
                ("strategy", text("safe")),
                ("port", FieldValue::Integer(80)),
            ]),
            form(&[
                ("strategy", text("safe")),
                ("port", FieldValue::Number(8080.5)),
            ]),
            form(&[
                ("strategy", text("safe")),
                ("tags", FieldValue::Choices(Vec::new())),
            ]),
            form(&[
                ("strategy", text("safe")),
                ("tags", FieldValue::Choices(vec!["c".into()])),
            ]),
            InteractionAnswer::Option {
                option_id: "safe".into(),
            },
        ];
        for answer in rejected {
            assert!(validate(&pending, &answer).is_err(), "{answer:?}");
        }
    }

    #[test]
    fn answers_deserialize_from_plain_json_values() {
        let answer: InteractionAnswer = serde_json::from_value(serde_json::json!({
            "type": "form",
            "values": { "ok": true, "port": 8080, "ratio": 0.5, "name": "x", "tags": ["a"] }
        }))
        .unwrap();
        let InteractionAnswer::Form { values } = answer else {
            panic!("expected a form answer");
        };
        assert_eq!(values["ok"], FieldValue::Boolean(true));
        assert_eq!(values["port"], FieldValue::Integer(8080));
        assert_eq!(values["ratio"], FieldValue::Number(0.5));
        assert_eq!(values["tags"], FieldValue::Choices(vec!["a".into()]));
    }
}
