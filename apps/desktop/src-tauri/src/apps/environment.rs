use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EnvironmentTemplateError {
    pub message: String,
}

pub(crate) fn is_variable_name(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some('_' | 'A'..='Z' | 'a'..='z'))
        && chars.all(|character| matches!(character, '_' | 'A'..='Z' | 'a'..='z' | '0'..='9'))
}

pub(crate) fn references(
    environment: &BTreeMap<String, String>,
) -> Result<Vec<String>, EnvironmentTemplateError> {
    let mut names = BTreeSet::new();
    for value in environment.values() {
        parse_template(value, |name| {
            names.insert(name.to_string());
            None
        })?;
    }
    Ok(names.into_iter().collect())
}

pub(crate) fn resolve(
    environment: &BTreeMap<String, String>,
    values: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, Vec<String>> {
    let mut missing = BTreeSet::new();
    let mut resolved = BTreeMap::new();
    for (key, value) in environment {
        let rendered = parse_template(value, |name| match values.get(name) {
            Some(value) => Some(value.clone()),
            None => {
                missing.insert(name.to_string());
                Some(String::new())
            }
        })
        .expect("validated environment template");
        resolved.insert(key.clone(), rendered);
    }
    if missing.is_empty() {
        Ok(resolved)
    } else {
        Err(missing.into_iter().collect())
    }
}

fn parse_template(
    value: &str,
    mut substitute: impl FnMut(&str) -> Option<String>,
) -> Result<String, EnvironmentTemplateError> {
    let bytes = value.as_bytes();
    let mut output = String::new();
    let mut cursor = 0;
    let mut copied_until = 0;

    while cursor < bytes.len() {
        if bytes[cursor] != b'$' {
            cursor += value[cursor..]
                .chars()
                .next()
                .expect("cursor is in bounds")
                .len_utf8();
            continue;
        }

        let escaped = bytes.get(cursor + 1) == Some(&b'$') && bytes.get(cursor + 2) == Some(&b'{');
        let reference = bytes.get(cursor + 1) == Some(&b'{');
        if !escaped && !reference {
            cursor += 1;
            continue;
        }

        let name_start = cursor + if escaped { 3 } else { 2 };
        let Some(relative_end) = value[name_start..].find('}') else {
            return Err(EnvironmentTemplateError {
                message: "environment reference is missing a closing brace".to_string(),
            });
        };
        let name_end = name_start + relative_end;
        let name = &value[name_start..name_end];
        if !is_variable_name(name) {
            return Err(EnvironmentTemplateError {
                message: format!("unsupported environment reference: ${{{name}}}"),
            });
        }

        output.push_str(&value[copied_until..cursor]);
        if escaped {
            output.push_str("${");
            output.push_str(name);
            output.push('}');
        } else if let Some(value) = substitute(name) {
            output.push_str(&value);
        }
        cursor = name_end + 1;
        copied_until = cursor;
    }
    output.push_str(&value[copied_until..]);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_literals_multiple_references_and_escape_without_recursion() {
        let environment = BTreeMap::from([
            (
                "DATABASE_URL".to_string(),
                "postgres://${USER}:${PASSWORD}@localhost/$${DB}".to_string(),
            ),
            ("TOKEN".to_string(), "${INDIRECT}".to_string()),
        ]);
        let values = BTreeMap::from([
            ("USER".to_string(), "svode".to_string()),
            ("PASSWORD".to_string(), "secret".to_string()),
            ("INDIRECT".to_string(), "${PASSWORD}".to_string()),
        ]);

        assert_eq!(
            references(&environment).unwrap(),
            vec!["INDIRECT", "PASSWORD", "USER"]
        );
        assert_eq!(
            resolve(&environment, &values).unwrap(),
            BTreeMap::from([
                (
                    "DATABASE_URL".to_string(),
                    "postgres://svode:secret@localhost/${DB}".to_string(),
                ),
                ("TOKEN".to_string(), "${PASSWORD}".to_string()),
            ])
        );
    }

    #[test]
    fn reports_all_missing_references() {
        let environment = BTreeMap::from([(
            "VALUE".to_string(),
            "${SECOND}-${FIRST}-${SECOND}".to_string(),
        )]);
        assert_eq!(
            resolve(&environment, &BTreeMap::new()).unwrap_err(),
            vec!["FIRST", "SECOND"]
        );
    }

    #[test]
    fn rejects_defaults_functions_and_expressions() {
        for value in ["${NAME:-default}", "${env(NAME)}", "${A + B}", "${}"] {
            assert!(references(&BTreeMap::from([("KEY".to_string(), value.to_string())])).is_err());
        }
    }
}
