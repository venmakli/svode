//! The model and reasoning a session last ran with, as its agent's native
//! store recorded them, matched with the values the agent declares (Stage
//! 10 DF-171 R2, the agents' dialects of `03`). Attaching the session takes
//! the matched values for the settings the user did not choose; the host
//! reads the store, the runtime never does.

use serde::Serialize;
use svode_core::agent_adapters::AgentAdapterKind;

use crate::SettingValue;
use crate::activity::{SessionSetting, SettingCategory};

/// The model and reasoning of the session's last turn in its native store.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NativeSessionSettings {
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// What the session's own values give attaching it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionValues {
    /// Declared values, the model before the reasoning.
    pub values: Vec<SettingValue>,
    /// The name of the session's model when no declared model matches it;
    /// the turn then runs on the agent's model.
    pub unavailable_model: Option<String>,
}

/// The declared values of `declared` that match the session's native
/// settings by the dialect of `adapter`; nothing for an agent without one.
pub fn session_values(
    adapter: AgentAdapterKind,
    declared: &[SessionSetting],
    native: &NativeSessionSettings,
) -> SessionValues {
    let dialect = match adapter {
        AgentAdapterKind::ClaudeCode => Dialect::ClaudeCode,
        AgentAdapterKind::Codex => Dialect::Codex,
        _ => return SessionValues::default(),
    };
    let setting = |category| declared.iter().find(|setting| setting.category == category);
    let mut values = SessionValues::default();
    if let Some(model) = native.model.as_deref()
        && let Some(setting) = setting(SettingCategory::Model)
    {
        match dialect.model_option(setting, model) {
            Some(value) => values.values.push(SettingValue {
                setting: setting.id.clone(),
                value,
            }),
            None => values.unavailable_model = Some(dialect.model_name(model)),
        }
    }
    if let Some(effort) = native.effort.as_deref()
        && let Some(setting) = setting(SettingCategory::ThoughtLevel)
        && setting.options.iter().any(|option| option.value == effort)
    {
        values.values.push(SettingValue {
            setting: setting.id.clone(),
            value: effort.to_string(),
        });
    }
    values
}

#[derive(Clone, Copy)]
enum Dialect {
    /// claude-agent-acp offers aliases such as `haiku` named with the
    /// version they resolve to, or full model ids of an allowlist; the
    /// transcript records the full id the turn ran on.
    ClaudeCode,
    /// codex-acp offers the model ids the rollout records.
    Codex,
}

impl Dialect {
    fn model_option(self, setting: &SessionSetting, model: &str) -> Option<String> {
        let model = model.trim().to_ascii_lowercase();
        let exact = setting
            .options
            .iter()
            .find(|option| option.value.to_ascii_lowercase() == model);
        if let Some(option) = exact {
            return Some(option.value.clone());
        }
        match self {
            Dialect::Codex => None,
            Dialect::ClaudeCode => {
                let wanted = ClaudeModel::parse(&model)?;
                setting
                    .options
                    .iter()
                    .filter(|option| option.value != "default")
                    .find(|option| wanted.offered_by(option))
                    .map(|option| option.value.clone())
            }
        }
    }

    fn model_name(self, model: &str) -> String {
        match self {
            Dialect::ClaudeCode => ClaudeModel::parse(&model.to_ascii_lowercase())
                .map(|model| model.name())
                .unwrap_or_else(|| model.to_string()),
            // As codex-acp names a model it does not list.
            Dialect::Codex => match model.get(..4) {
                Some(prefix) if prefix.eq_ignore_ascii_case("gpt-") => model[4..]
                    .split(['-', '/'])
                    .filter(|part| !part.is_empty())
                    .map(capitalize)
                    .collect::<Vec<_>>()
                    .join(" "),
                _ => model.to_string(),
            },
        }
    }
}

/// A Claude model id such as `claude-haiku-4-5-20251001` or
/// `claude-opus-5-5[1m]`: its family, version and context hint.
struct ClaudeModel {
    family: String,
    version: Option<String>,
    context: Option<String>,
}

impl ClaudeModel {
    fn parse(model: &str) -> Option<Self> {
        let (id, context) = split_context(model);
        let mut family = None;
        let mut numbers = Vec::new();
        for part in id.strip_prefix("claude-")?.split('-') {
            if part.chars().all(|char| char.is_ascii_digit()) {
                // A date such as `20251001` is no part of the version.
                if part.len() <= 2 && numbers.len() < 2 {
                    numbers.push(part);
                }
            } else if family.is_none() && part.chars().all(|char| char.is_ascii_alphabetic()) {
                family = Some(part.to_string());
            }
        }
        Some(Self {
            family: family?,
            version: (!numbers.is_empty()).then(|| numbers.join(".")),
            context,
        })
    }

    /// The option is this model: the same context window and the same
    /// version of the family in its name, description or value, as the
    /// adapter names an alias after the model it resolves to.
    fn offered_by(&self, option: &crate::activity::SettingOption) -> bool {
        let value = option.value.to_ascii_lowercase();
        let (value, context) = split_context(&value);
        if context != self.context {
            return false;
        }
        let texts = [
            option.name.to_ascii_lowercase(),
            option
                .description
                .as_deref()
                .unwrap_or("")
                .to_ascii_lowercase(),
            value.to_string(),
        ];
        let version = texts
            .iter()
            .find_map(|text| family_version(text, &self.family));
        version.is_some() && version == self.version
    }

    fn name(&self) -> String {
        let family = capitalize(&self.family);
        match &self.version {
            Some(version) => format!("{family} {version}"),
            None => family,
        }
    }
}

/// The id without its context hint such as `[1m]`, and the hint.
fn split_context(id: &str) -> (&str, Option<String>) {
    match id.strip_suffix(']').and_then(|rest| rest.rsplit_once('[')) {
        Some((id, hint)) => (id, Some(hint.to_string())),
        None => (id, None),
    }
}

/// The version after the family's word in `text`: `haiku 4.5`, `haiku-4-5`.
fn family_version(text: &str, family: &str) -> Option<String> {
    let mut rest = text;
    while let Some(at) = rest.find(family) {
        let before = rest[..at].chars().next_back();
        let after = &rest[at + family.len()..];
        rest = after;
        if before.is_some_and(|char| char.is_ascii_alphanumeric()) {
            continue;
        }
        let digits = after.trim_start_matches([' ', '-']);
        if digits.len() == after.len() {
            continue;
        }
        let major: String = digits.chars().take_while(char::is_ascii_digit).collect();
        if major.is_empty() {
            continue;
        }
        let tail = &digits[major.len()..];
        let minor: String = tail
            .strip_prefix(['.', '-'])
            .map(|tail| tail.chars().take_while(char::is_ascii_digit).collect())
            .unwrap_or_default();
        // A date after the version is no minor version.
        return Some(if minor.is_empty() || minor.len() > 2 {
            major
        } else {
            format!("{major}.{minor}")
        });
    }
    None
}

fn capitalize(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity::SettingOption;

    fn setting(
        id: &str,
        category: SettingCategory,
        current: &str,
        options: &[(&str, &str, Option<&str>)],
    ) -> SessionSetting {
        SessionSetting {
            id: id.into(),
            name: id.into(),
            description: None,
            category,
            current_value: current.into(),
            options: options
                .iter()
                .map(|(value, name, description)| SettingOption {
                    value: (*value).into(),
                    name: (*name).into(),
                    description: description.map(Into::into),
                })
                .collect(),
        }
    }

    /// The settings claude-agent-acp 0.85 declares for a session loaded
    /// with `"model": "opus"` in the user's settings.
    fn claude_code() -> Vec<SessionSetting> {
        vec![
            setting(
                "mode",
                SettingCategory::Mode,
                "default",
                &[("default", "Manual", None), ("plan", "Plan", None)],
            ),
            setting(
                "model",
                SettingCategory::Model,
                "opus",
                &[
                    ("default", "Default (recommended)", Some("Opus 5.5")),
                    ("opus", "Opus 5.5", Some("Opus 5.5 · Most capable")),
                    (
                        "opus[1m]",
                        "Opus 5.5 (1M context)",
                        Some("Opus 5.5 for long sessions"),
                    ),
                    ("sonnet", "Sonnet 5", Some("Sonnet 5 · Everyday tasks")),
                    ("haiku", "Haiku 4.5", Some("Haiku 4.5 · Fastest")),
                ],
            ),
            setting(
                "effort",
                SettingCategory::ThoughtLevel,
                "high",
                &[
                    ("default", "Default", None),
                    ("low", "Low", None),
                    ("high", "High", None),
                    ("max", "Max", None),
                ],
            ),
        ]
    }

    /// The settings codex-acp 2.1 declares for a thread resumed on the
    /// model of `config.toml`.
    fn codex() -> Vec<SessionSetting> {
        vec![
            setting(
                "model",
                SettingCategory::Model,
                "gpt-6-astra",
                &[
                    ("gpt-6-astra", "6 Astra", None),
                    ("gpt-6-luna", "6 Luna", None),
                ],
            ),
            setting(
                "reasoning_effort",
                SettingCategory::ThoughtLevel,
                "high",
                &[
                    ("low", "Low", None),
                    ("medium", "Medium", None),
                    ("high", "High", None),
                ],
            ),
        ]
    }

    fn native(model: Option<&str>, effort: Option<&str>) -> NativeSessionSettings {
        NativeSessionSettings {
            model: model.map(Into::into),
            effort: effort.map(Into::into),
        }
    }

    fn value(setting: &str, value: &str) -> SettingValue {
        SettingValue {
            setting: setting.into(),
            value: value.into(),
        }
    }

    #[test]
    fn a_claude_code_session_continues_on_the_alias_named_after_its_model() {
        let values = session_values(
            AgentAdapterKind::ClaudeCode,
            &claude_code(),
            &native(Some("claude-haiku-4-5-20251001"), None),
        );
        assert_eq!(
            values,
            SessionValues {
                values: vec![value("model", "haiku")],
                unavailable_model: None,
            }
        );

        // The alias without the context hint, and the turn's effort.
        let values = session_values(
            AgentAdapterKind::ClaudeCode,
            &claude_code(),
            &native(Some("claude-opus-5-5"), Some("max")),
        );
        assert_eq!(
            values.values,
            [value("model", "opus"), value("effort", "max")]
        );

        let values = session_values(
            AgentAdapterKind::ClaudeCode,
            &claude_code(),
            &native(Some("claude-opus-5-5[1m]"), None),
        );
        assert_eq!(values.values, [value("model", "opus[1m]")]);
    }

    #[test]
    fn a_claude_code_model_no_option_offers_is_named_and_left_to_the_agent() {
        // Another version of the family, and a family the agent dropped.
        for (model, name) in [
            ("claude-haiku-5-5", "Haiku 5.5"),
            ("claude-sonnet-5-5", "Sonnet 5.5"),
            ("claude-fable-5-1", "Fable 5.1"),
        ] {
            let values = session_values(
                AgentAdapterKind::ClaudeCode,
                &claude_code(),
                &native(Some(model), Some("high")),
            );
            assert_eq!(
                values,
                SessionValues {
                    values: vec![value("effort", "high")],
                    unavailable_model: Some(name.into()),
                },
                "{model}"
            );
        }
        // A full id an allowlist offers matches as it is.
        let mut allowlist = claude_code();
        allowlist[1].options.push(SettingOption {
            value: "claude-sonnet-5-5".into(),
            name: "claude-sonnet-5-5".into(),
            description: None,
        });
        let values = session_values(
            AgentAdapterKind::ClaudeCode,
            &allowlist,
            &native(Some("claude-sonnet-5-5"), None),
        );
        assert_eq!(values.values, [value("model", "claude-sonnet-5-5")]);
    }

    #[test]
    fn a_codex_session_continues_on_the_model_and_effort_of_its_last_turn() {
        let values = session_values(
            AgentAdapterKind::Codex,
            &codex(),
            &native(Some("gpt-6-luna"), Some("low")),
        );
        assert_eq!(
            values,
            SessionValues {
                values: vec![
                    value("model", "gpt-6-luna"),
                    value("reasoning_effort", "low")
                ],
                unavailable_model: None,
            }
        );

        let values = session_values(
            AgentAdapterKind::Codex,
            &codex(),
            &native(Some("gpt-6.1-sol"), Some("ultra")),
        );
        assert_eq!(
            values,
            SessionValues {
                values: Vec::new(),
                unavailable_model: Some("6.1 Sol".into()),
            },
            "an effort the agent does not declare is left out without a line"
        );
    }

    #[test]
    fn other_agents_and_a_log_without_a_model_give_nothing() {
        assert_eq!(
            session_values(
                AgentAdapterKind::Hermes,
                &codex(),
                &native(Some("gpt-6-luna"), Some("low")),
            ),
            SessionValues::default()
        );
        assert_eq!(
            session_values(AgentAdapterKind::Codex, &codex(), &native(None, None)),
            SessionValues::default()
        );
        // Without a declared model there is nothing to tell unavailable.
        assert_eq!(
            session_values(
                AgentAdapterKind::Codex,
                &codex()[1..],
                &native(Some("gpt-6-luna"), Some("low")),
            ),
            SessionValues {
                values: vec![value("reasoning_effort", "low")],
                unavailable_model: None,
            }
        );
    }
}
