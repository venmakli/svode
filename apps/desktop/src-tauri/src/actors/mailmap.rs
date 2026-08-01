use std::collections::HashMap;

const MAX_MAILMAP_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Identity {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct MailmapRule {
    pub canonical: Identity,
    pub alias_name: Option<String>,
    pub alias_email: String,
    pub line: usize,
    pub raw: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum MailmapDiagnosticKind {
    InvalidLine,
    UnsafeFile,
    CustomSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct MailmapDiagnostic {
    pub kind: MailmapDiagnosticKind,
    pub line: Option<usize>,
    pub message: String,
    pub blocking: bool,
}

#[derive(Debug, Clone, Default)]
pub(super) struct MailmapDocument {
    pub rules: Vec<MailmapRule>,
    pub diagnostics: Vec<MailmapDiagnostic>,
    email_rules: HashMap<String, usize>,
    name_email_rules: HashMap<(String, String), usize>,
}

impl MailmapDocument {
    pub fn parse(raw: &str) -> Self {
        let mut document = Self::default();
        for (index, source_line) in raw.lines().enumerate() {
            let line_number = index + 1;
            let content = source_line
                .split_once('#')
                .map_or(source_line, |(content, _)| content)
                .trim();
            if content.is_empty() {
                continue;
            }
            match parse_rule(content, line_number) {
                Some(rule) => document.rules.push(rule),
                None => document.diagnostics.push(MailmapDiagnostic {
                    kind: MailmapDiagnosticKind::InvalidLine,
                    line: Some(line_number),
                    message: format!("invalid .mailmap entry on line {line_number}"),
                    blocking: true,
                }),
            }
        }
        document.rebuild_indexes();
        document
    }

    pub fn resolve(&self, name: &str, email: &str) -> Identity {
        let normalized_email = normalize_email(email);
        let specific_key = (normalized_email.clone(), normalize_name(name));
        let rule = self
            .name_email_rules
            .get(&specific_key)
            .or_else(|| self.email_rules.get(&normalized_email))
            .and_then(|index| self.rules.get(*index));
        match rule {
            Some(rule) => Identity {
                name: if rule.canonical.name.is_empty() {
                    name.trim().to_string()
                } else {
                    rule.canonical.name.clone()
                },
                email: rule.canonical.email.clone(),
            },
            None => Identity {
                name: name.trim().to_string(),
                email: normalized_email,
            },
        }
    }

    pub fn add_diagnostic(&mut self, diagnostic: MailmapDiagnostic) {
        self.diagnostics.push(diagnostic);
    }

    pub fn unsafe_file(message: impl Into<String>) -> Self {
        Self {
            diagnostics: vec![MailmapDiagnostic {
                kind: MailmapDiagnosticKind::UnsafeFile,
                line: None,
                message: message.into(),
                blocking: true,
            }],
            ..Self::default()
        }
    }

    pub fn custom_source(key: &str, value: &str) -> MailmapDiagnostic {
        MailmapDiagnostic {
            kind: MailmapDiagnosticKind::CustomSource,
            line: None,
            message: format!(
                "Git {key} is configured as {:?}; Svode uses only the repository .mailmap",
                truncate(value, 512)
            ),
            blocking: false,
        }
    }

    fn rebuild_indexes(&mut self) {
        self.email_rules.clear();
        self.name_email_rules.clear();
        for (index, rule) in self.rules.iter().enumerate() {
            if let Some(alias_name) = rule.alias_name.as_ref() {
                self.name_email_rules.insert(
                    (rule.alias_email.clone(), normalize_name(alias_name)),
                    index,
                );
            } else {
                self.email_rules.insert(rule.alias_email.clone(), index);
            }
        }
    }
}

pub(super) fn mailmap_size_is_safe(size: u64) -> bool {
    size <= MAX_MAILMAP_BYTES
}

pub(super) fn normalize_email(raw: &str) -> String {
    raw.trim().to_lowercase()
}

fn normalize_name(raw: &str) -> String {
    raw.trim().to_lowercase()
}

fn parse_rule(raw: &str, line: usize) -> Option<MailmapRule> {
    let pairs = angle_pairs(raw)?;
    match pairs.as_slice() {
        [(first_start, first_end)] => {
            let canonical_name = raw[..*first_start].trim();
            let alias_email = raw[first_start + 1..*first_end].trim();
            if canonical_name.is_empty() || !valid_email_token(alias_email) {
                return None;
            }
            let email = normalize_email(alias_email);
            Some(MailmapRule {
                canonical: Identity {
                    name: canonical_name.to_string(),
                    email: email.clone(),
                },
                alias_name: None,
                alias_email: email,
                line,
                raw: raw.to_string(),
            })
        }
        [(first_start, first_end), (second_start, second_end)] => {
            let canonical_name = raw[..*first_start].trim();
            let canonical_email = raw[first_start + 1..*first_end].trim();
            let alias_name = raw[first_end + 1..*second_start].trim();
            let alias_email = raw[second_start + 1..*second_end].trim();
            if !valid_email_token(canonical_email)
                || !valid_email_token(alias_email)
                || (!alias_name.is_empty() && canonical_name.is_empty())
            {
                return None;
            }
            Some(MailmapRule {
                canonical: Identity {
                    name: canonical_name.to_string(),
                    email: normalize_email(canonical_email),
                },
                alias_name: (!alias_name.is_empty()).then(|| alias_name.to_string()),
                alias_email: normalize_email(alias_email),
                line,
                raw: raw.to_string(),
            })
        }
        _ => None,
    }
}

fn angle_pairs(raw: &str) -> Option<Vec<(usize, usize)>> {
    let mut pairs = Vec::new();
    let mut start = None;
    for (index, ch) in raw.char_indices() {
        match ch {
            '<' if start.is_none() => start = Some(index),
            '<' => return None,
            '>' => {
                let open = start.take()?;
                pairs.push((open, index));
            }
            _ => {}
        }
    }
    if start.is_some() || pairs.is_empty() {
        return None;
    }
    let last_end = pairs.last()?.1;
    raw[last_end + 1..].trim().is_empty().then_some(pairs)
}

fn valid_email_token(value: &str) -> bool {
    !value.is_empty() && !value.contains(char::is_whitespace) && !value.contains(['<', '>'])
}

fn truncate(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let prefix: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{prefix}…")
    } else {
        prefix
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_four_forms_and_materializes_canonical_identity() {
        let document = MailmapDocument::parse(
            "Proper One <one@old.test>\n\
             <two@new.test> <two@old.test>\n\
             Proper Three <three@new.test> <three@old.test>\n\
             Proper Four <four@new.test> Commit Four <four@old.test>\n",
        );

        assert!(document.diagnostics.is_empty());
        assert_eq!(document.rules.len(), 4);
        assert_eq!(
            document.resolve("Raw One", "ONE@OLD.TEST"),
            Identity {
                name: "Proper One".into(),
                email: "one@old.test".into()
            }
        );
        assert_eq!(
            document.resolve("Raw Two", "TWO@OLD.TEST"),
            Identity {
                name: "Raw Two".into(),
                email: "two@new.test".into()
            }
        );
        assert_eq!(
            document.resolve("Raw Three", "three@old.test"),
            Identity {
                name: "Proper Three".into(),
                email: "three@new.test".into()
            }
        );
        assert_eq!(
            document.resolve("commit four", "FOUR@OLD.TEST"),
            Identity {
                name: "Proper Four".into(),
                email: "four@new.test".into()
            }
        );
    }

    #[test]
    fn specific_rules_win_and_later_same_keys_replace_earlier_rules() {
        let document = MailmapDocument::parse(
            "Generic First <first@test> <alias@test>\n\
             Specific First <specific-first@test> Commit Name <alias@test>\n\
             Generic Last <last@test> <alias@test>\n\
             Specific Last <specific-last@test> Commit Name <alias@test>\n",
        );

        assert_eq!(document.resolve("other", "alias@test").email, "last@test");
        assert_eq!(
            document.resolve("COMMIT NAME", "ALIAS@TEST").email,
            "specific-last@test"
        );
    }

    #[test]
    fn invalid_non_comment_lines_are_blocking_but_valid_rules_remain_active() {
        let document = MailmapDocument::parse(
            "not a mapping\nProper <proper@test> <alias@test> # trailing comment\n",
        );

        assert_eq!(document.rules.len(), 1);
        assert_eq!(document.diagnostics.len(), 1);
        assert!(document.diagnostics[0].blocking);
        assert_eq!(document.diagnostics[0].line, Some(1));
        assert_eq!(document.resolve("Alias", "alias@test").email, "proper@test");
    }

    #[test]
    fn accepts_opaque_git_identity_tokens_without_an_at_sign() {
        let document = MailmapDocument::parse("Proper <canonical> <alias>\n");

        assert!(document.diagnostics.is_empty());
        assert_eq!(document.resolve("Alias", "alias").email, "canonical");
    }
}
