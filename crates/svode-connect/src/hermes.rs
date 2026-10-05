//! The own part of Hermes (Stage 10 `03` A9, E03). Hermes reads skills from
//! its own directory and from the directories `skills.external_dirs` of
//! `~/.hermes/config.yaml` lists, not from `~/.agents/skills`. Its own part
//! is an item of that list that names the shared skill directory and carries
//! the Svode marker as its comment. Hermes expands `~`, drops a directory
//! listed twice and keeps comments when it writes its config itself.
//!
//! `hermes mcp add` asks a question and never writes without a terminal, so
//! the manager edits the YAML line by line, keeps every other byte and
//! checks the result with a YAML parser before writing it.

use std::path::{Path, PathBuf};

use serde_yml::{Mapping, Value};

use crate::entry::{self, Entry, Launch, MARKER};
use crate::error::ConnectError;
use crate::machine::Machine;

/// The shared skill directory as the item of Svode names it.
pub(crate) const SHARED_DIR: &str = "~/.agents/skills";

const SKILLS: &str = "skills";
const DIRS: &str = "external_dirs";

/// The item of Svode; its "launch" is the directory it lists.
pub(crate) fn read(machine: &Machine) -> Entry {
    let path = machine.hermes_config();
    let text = match entry::read_text(&path) {
        Ok(text) => text,
        Err(error) => return Entry::Unreadable(error.message),
    };
    if let Err(error) = parse(&path, &text) {
        return Entry::Unreadable(error.message);
    }
    let lines = text.split('\n').collect::<Vec<_>>();
    let dir = scan(&lines)
        .ok()
        .and_then(|skills| skills.marked().next().map(|item| item.value.clone()));
    match dir {
        Some(dir) => Entry::Managed(Some(Launch {
            command: dir,
            args: Vec::new(),
            env_vars: Vec::new(),
        })),
        None => Entry::Absent,
    }
}

/// Lists the shared skill directory as the item of Svode, replacing an item
/// of Svode of another form.
pub(crate) fn write(machine: &Machine) -> Result<(), ConnectError> {
    let path = machine.hermes_config();
    let before = entry::read_text(&path)?;
    let value = parse(&path, &before)?;
    let unsupported = || unsupported_form(&path);
    let (mut lines, removed) = without_marked(&before).ok_or_else(unsupported)?;
    let skills = scan(&lines).map_err(|()| unsupported())?;
    let item = |indent: usize| format!("{}- {SHARED_DIR}  # {MARKER}", " ".repeat(indent));
    match (&skills.key, &skills.dirs) {
        (_, Some(dirs)) => {
            let mut at = dirs.key + 1;
            let mut indent = dirs.indent + 2;
            if let Some(last) = dirs.items.last() {
                at = last.line + 1;
                indent = last.indent;
            }
            lines.insert(at, item(indent).into());
            if dirs.flow_empty {
                let comment = split_comment(lines[dirs.key].trim_start()).1;
                lines[dirs.key] = format!(
                    "{}{DIRS}:{}",
                    " ".repeat(dirs.indent),
                    comment
                        .map(|comment| format!(" {comment}"))
                        .unwrap_or_default()
                )
                .into();
            }
        }
        (Some(key), None) => {
            let indent = skills.child.unwrap_or(2);
            lines.insert(key + 1, item(indent + 2).into());
            lines.insert(key + 1, format!("{}{DIRS}:", " ".repeat(indent)).into());
        }
        (None, None) => {
            // Before the empty piece that follows a last newline.
            let at = if lines.last().is_some_and(|line| line.is_empty()) {
                lines.len() - 1
            } else {
                lines.push("".into());
                lines.len() - 1
            };
            for line in [format!("{SKILLS}:"), format!("  {DIRS}:"), item(4)]
                .into_iter()
                .rev()
            {
                lines.insert(at, line.into());
            }
        }
    }
    let after = lines.join("\n");
    let expected = with_dir(without(value, &removed)).ok_or_else(unsupported)?;
    check(&path, &after, &expected)?;
    entry::write_if_unchanged(&path, &before, &after)
}

/// Removes the items of Svode, then the `external_dirs` and `skills` keys
/// they leave empty, so a config Svode added them to gets its bytes back.
pub(crate) fn remove(machine: &Machine) -> Result<(), ConnectError> {
    let path = machine.hermes_config();
    let before = entry::read_text(&path)?;
    let value = parse(&path, &before)?;
    let unsupported = || unsupported_form(&path);
    let (mut lines, removed) = without_marked(&before).ok_or_else(unsupported)?;
    if removed.is_empty() {
        return Ok(());
    }
    let skills = scan(&lines).map_err(|()| unsupported())?;
    if let Some(dirs) = &skills.dirs
        && dirs.items.is_empty()
        && !dirs.flow_empty
        && bare_key(&lines[dirs.key])
    {
        lines.remove(dirs.key);
    }
    let skills = scan(&lines).map_err(|()| unsupported())?;
    if let Some(key) = skills.key
        && skills.child.is_none()
        && bare_key(&lines[key])
    {
        lines.remove(key);
    }
    let after = lines.join("\n");
    check(&path, &after, &without(value, &removed))?;
    entry::write_if_unchanged(&path, &before, &after)
}

/// Whether an item of `skills.external_dirs`, of Svode or not, names the
/// shared skill directory: Hermes then reads the shared skill.
pub(crate) fn lists_shared_dir(machine: &Machine) -> bool {
    let Some(skills) = config(machine).and_then(|value| value.get(SKILLS).cloned()) else {
        return false;
    };
    let shared = machine.shared_skill_link();
    let shared = shared.parent().unwrap_or(&shared);
    let dirs = match skills.get(DIRS) {
        Some(Value::String(dir)) => vec![dir.clone()],
        Some(Value::Sequence(dirs)) => dirs
            .iter()
            .filter_map(|dir| dir.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    };
    dirs.iter()
        .any(|dir| expand(&machine.home, dir.trim()) == shared)
}

/// The config of Hermes, when it is readable YAML.
pub(crate) fn config(machine: &Machine) -> Option<Value> {
    let path = machine.hermes_config();
    parse(&path, &entry::read_text(&path).ok()?).ok()
}

/// A directory as Hermes expands it: `~` and `$HOME` are the home
/// directory, a relative one is in `~/.hermes`.
fn expand(home: &Path, dir: &str) -> PathBuf {
    let rest = ["~", "${HOME}", "$HOME"]
        .iter()
        .find_map(|prefix| dir.strip_prefix(prefix))
        .filter(|rest| rest.is_empty() || rest.starts_with('/'));
    match rest {
        Some(rest) => home.join(rest.trim_start_matches('/')),
        None if Path::new(dir).is_absolute() => PathBuf::from(dir),
        None => home.join(".hermes").join(dir),
    }
}

fn unsupported_form(path: &Path) -> ConnectError {
    ConnectError::new(
        "CONFIG_UNSUPPORTED_FORM",
        format!(
            "skills.external_dirs in {} has a form Svode does not edit; nothing was written",
            path.display()
        ),
    )
}

fn parse(path: &Path, text: &str) -> Result<Value, ConnectError> {
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_yml::from_str(text).map_err(|error| {
        ConnectError::new("CONFIG_UNREADABLE", format!("{}: {error}", path.display()))
    })
}

/// The edited text parses to exactly the value the edit meant.
fn check(path: &Path, after: &str, expected: &Value) -> Result<(), ConnectError> {
    match parse(path, after) {
        Ok(value) if normalized(value.clone()) == normalized(expected.clone()) => Ok(()),
        _ => Err(unsupported_form(path)),
    }
}

/// The lines without the items of Svode, and the directories they named.
fn without_marked(text: &str) -> Option<(Vec<std::borrow::Cow<'_, str>>, Vec<String>)> {
    let lines = text.split('\n').collect::<Vec<_>>();
    let skills = scan(&lines).ok()?;
    let marked = skills.marked().collect::<Vec<_>>();
    let removed = marked.iter().map(|item| item.value.clone()).collect();
    let kept = lines
        .iter()
        .enumerate()
        .filter(|(index, _)| !marked.iter().any(|item| item.line == *index))
        .map(|(_, line)| std::borrow::Cow::Borrowed(*line))
        .collect();
    Some((kept, removed))
}

/// `value` with one item of `skills.external_dirs` less per directory of
/// `removed`.
fn without(mut value: Value, removed: &[String]) -> Value {
    if let Some(Value::Sequence(dirs)) = value
        .get_mut(SKILLS)
        .and_then(|skills| skills.get_mut(DIRS))
    {
        for dir in removed {
            if let Some(index) = dirs.iter().position(|item| item.as_str() == Some(dir)) {
                dirs.remove(index);
            }
        }
    }
    value
}

/// `value` with the shared skill directory appended to
/// `skills.external_dirs`; `None` where a key holds something else.
fn with_dir(mut value: Value) -> Option<Value> {
    if value.is_null() {
        value = Value::Mapping(Mapping::new());
    }
    let root = value.as_mapping_mut()?;
    let skills = root.entry(SKILLS.into()).or_insert(Value::Null);
    if skills.is_null() {
        *skills = Value::Mapping(Mapping::new());
    }
    let dirs = skills
        .as_mapping_mut()?
        .entry(DIRS.into())
        .or_insert(Value::Null);
    if dirs.is_null() {
        *dirs = Value::Sequence(Vec::new());
    }
    dirs.as_sequence_mut()?
        .push(Value::String(SHARED_DIR.into()));
    Some(value)
}

/// Hermes reads an empty or missing `external_dirs`, `skills` and config
/// alike.
fn normalized(mut value: Value) -> Value {
    if let Some(root) = value.as_mapping_mut() {
        if let Some(skills) = root.get_mut(SKILLS).and_then(Value::as_mapping_mut) {
            let empty = skills.get(DIRS).is_some_and(|dirs| {
                dirs.is_null() || dirs.as_sequence().is_some_and(Vec::is_empty)
            });
            if empty {
                skills.remove(DIRS);
            }
        }
        let empty = root.get(SKILLS).is_some_and(|skills| {
            skills.is_null() || skills.as_mapping().is_some_and(Mapping::is_empty)
        });
        if empty {
            root.remove(SKILLS);
        }
        // An empty config reads as no config.
        if root.is_empty() {
            return Value::Null;
        }
    }
    value
}

/// The `skills` block of the config as lines: where its keys and the items
/// of `external_dirs` are.
#[derive(Debug)]
struct Skills {
    /// The `skills:` line; `None` when the config has none.
    key: Option<usize>,
    /// Indent of the keys inside the block, when it has any.
    child: Option<usize>,
    dirs: Option<Dirs>,
}

#[derive(Debug)]
struct Dirs {
    key: usize,
    indent: usize,
    /// `external_dirs: []`.
    flow_empty: bool,
    items: Vec<Item>,
}

#[derive(Debug)]
struct Item {
    line: usize,
    indent: usize,
    value: String,
    marked: bool,
}

impl Skills {
    fn marked(&self) -> impl Iterator<Item = &Item> {
        self.dirs
            .iter()
            .flat_map(|dirs| &dirs.items)
            .filter(|item| item.marked)
    }
}

/// Finds the block in the forms the manager edits; `Err` for another form,
/// such as a flow mapping or a list written inline.
fn scan(lines: &[impl AsRef<str>]) -> Result<Skills, ()> {
    let lines = lines.iter().map(AsRef::as_ref).collect::<Vec<_>>();
    let content = |line: &str| {
        let trimmed = line.trim();
        !trimmed.is_empty() && !trimmed.starts_with('#')
    };
    let Some(key) = lines
        .iter()
        .position(|line| indent(line) == 0 && key_of(line) == Some(SKILLS))
    else {
        return Ok(Skills {
            key: None,
            child: None,
            dirs: None,
        });
    };
    if !rest_of(lines[key]).is_empty() {
        return Err(());
    }
    let end = (key + 1..lines.len())
        .find(|&index| content(lines[index]) && indent(lines[index]) == 0)
        .unwrap_or(lines.len());
    let child = (key + 1..end)
        .find(|&index| content(lines[index]))
        .map(|index| indent(lines[index]));
    let dirs_key = (key + 1..end)
        .find(|&index| Some(indent(lines[index])) == child && key_of(lines[index]) == Some(DIRS));
    let Some(dirs_key) = dirs_key else {
        return Ok(Skills {
            key: Some(key),
            child,
            dirs: None,
        });
    };
    let dirs_indent = indent(lines[dirs_key]);
    let flow_empty = match rest_of(lines[dirs_key]) {
        "" => false,
        "[]" => true,
        _ => return Err(()),
    };
    let mut items = Vec::new();
    for (index, line) in lines.iter().enumerate().take(end).skip(dirs_key + 1) {
        if !content(line) {
            continue;
        }
        let trimmed = line.trim_start();
        let is_item = trimmed == "-" || trimmed.starts_with("- ");
        if !is_item || indent(line) < dirs_indent || flow_empty {
            if indent(line) > dirs_indent {
                return Err(());
            }
            break;
        }
        let (value, comment) = split_comment(trimmed[1..].trim_start());
        items.push(Item {
            line: index,
            indent: indent(line),
            value: unquote(value.trim()),
            marked: comment.is_some_and(|comment| comment.contains(MARKER)),
        });
    }
    Ok(Skills {
        key: Some(key),
        child,
        dirs: Some(Dirs {
            key: dirs_key,
            indent: dirs_indent,
            flow_empty,
            items,
        }),
    })
}

fn indent(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

/// The plain key of a `key: value` line.
fn key_of(line: &str) -> Option<&str> {
    let (key, rest) = line.trim().split_once(':')?;
    (rest.is_empty() || rest.starts_with([' ', '\t'])).then_some(key)
}

/// The value after the key of a `key: value` line, without its comment.
fn rest_of(line: &str) -> &str {
    let rest = line.trim().split_once(':').map_or("", |(_, rest)| rest);
    split_comment(rest).0.trim()
}

/// A line of nothing but its key: Svode wrote it and may take it back.
fn bare_key(line: &str) -> bool {
    split_comment(line.trim()).1.is_none() && rest_of(line).is_empty()
}

/// The text before a comment and the comment from its `#`.
fn split_comment(text: &str) -> (&str, Option<&str>) {
    let mut quote = None;
    let mut previous = ' ';
    for (index, char) in text.char_indices() {
        match (quote, char) {
            (None, '\'' | '"') => quote = Some(char),
            (Some(open), _) if char == open => quote = None,
            (None, '#') if previous.is_whitespace() => {
                return (&text[..index], Some(&text[index..]));
            }
            _ => {}
        }
        previous = char;
    }
    (text, None)
}

fn unquote(value: &str) -> String {
    for quote in ['\'', '"'] {
        if let Some(inner) = value
            .strip_prefix(quote)
            .and_then(|value| value.strip_suffix(quote))
        {
            return inner.to_string();
        }
    }
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home_with(config: &str) -> (tempfile::TempDir, Machine) {
        let dir = tempfile::tempdir().unwrap();
        let machine = Machine::at(dir.path().to_path_buf());
        if !config.is_empty() {
            std::fs::create_dir_all(dir.path().join(".hermes")).unwrap();
            std::fs::write(machine.hermes_config(), config).unwrap();
        }
        (dir, machine)
    }

    fn content(machine: &Machine) -> String {
        std::fs::read_to_string(machine.hermes_config()).unwrap_or_default()
    }

    const ITEM: &str = "- ~/.agents/skills  # svode-connection-v1";

    #[test]
    fn each_form_gets_the_item_and_its_bytes_back_on_removal() {
        for (before, after) in [
            ("", format!("skills:\n  external_dirs:\n    {ITEM}\n")),
            (
                "model:\n  default: x\n",
                format!("model:\n  default: x\nskills:\n  external_dirs:\n    {ITEM}\n"),
            ),
            (
                "model: x",
                format!("model: x\nskills:\n  external_dirs:\n    {ITEM}\n"),
            ),
            (
                "# top\nskills:\n  creation_nudge_interval: 15\n  disabled: []\ncode_execution:\n  timeout: 300\n",
                format!(
                    "# top\nskills:\n  external_dirs:\n    {ITEM}\n  creation_nudge_interval: 15\n  disabled: []\ncode_execution:\n  timeout: 300\n"
                ),
            ),
            (
                "skills:\n    external_dirs:\n    - /team/skills # theirs\n    other: 1\n",
                format!(
                    "skills:\n    external_dirs:\n    - /team/skills # theirs\n    {ITEM}\n    other: 1\n"
                ),
            ),
            (
                "skills:\n  external_dirs:\n    - ~/.agents/skills\n",
                format!("skills:\n  external_dirs:\n    - ~/.agents/skills\n    {ITEM}\n"),
            ),
        ] {
            let (_dir, machine) = home_with(before);
            write(&machine).unwrap();
            assert_eq!(content(&machine), after, "{before:?}");
            assert!(entry::is_canonical(&read(&machine), Path::new(SHARED_DIR)));
            assert!(lists_shared_dir(&machine));
            remove(&machine).unwrap();
            let restored = if before == "model: x" {
                "model: x\n"
            } else {
                before
            };
            assert_eq!(content(&machine), restored, "{before:?}");
            assert_eq!(read(&machine), Entry::Absent);
        }
    }

    #[test]
    fn an_empty_inline_list_becomes_a_block_and_stays_empty_after_removal() {
        let (_dir, machine) = home_with("skills:\n  external_dirs: [] # dirs\n  disabled: []\n");
        write(&machine).unwrap();
        assert_eq!(
            content(&machine),
            format!("skills:\n  external_dirs: # dirs\n    {ITEM}\n  disabled: []\n")
        );
        remove(&machine).unwrap();
        assert_eq!(
            content(&machine),
            "skills:\n  external_dirs: # dirs\n  disabled: []\n"
        );
    }

    #[test]
    fn forms_svode_does_not_edit_are_refused_without_a_write() {
        for config in [
            "skills: {external_dirs: [/a]}\n",
            "skills:\n  external_dirs: [/a, /b]\n",
            "skills:\n  external_dirs: /a\n",
            "\"skills\":\n  disabled: []\n",
        ] {
            let (_dir, machine) = home_with(config);
            assert_eq!(
                write(&machine).unwrap_err().code,
                "CONFIG_UNSUPPORTED_FORM",
                "{config}"
            );
            assert_eq!(content(&machine), config);
        }
        let (_dir, machine) = home_with("skills: [\n");
        assert!(matches!(read(&machine), Entry::Unreadable(_)));
        assert_eq!(write(&machine).unwrap_err().code, "CONFIG_UNREADABLE");
    }

    #[test]
    fn an_item_of_svode_of_another_form_is_replaced() {
        let (_dir, machine) =
            home_with("skills:\n  external_dirs:\n    - /old/skills  # svode-connection-v1\n");
        assert_eq!(
            read(&machine),
            Entry::Managed(Some(Launch {
                command: "/old/skills".into(),
                args: Vec::new(),
                env_vars: Vec::new(),
            }))
        );
        write(&machine).unwrap();
        assert_eq!(
            content(&machine),
            format!("skills:\n  external_dirs:\n    {ITEM}\n")
        );
    }

    #[test]
    fn directories_are_expanded_as_hermes_expands_them() {
        let home = Path::new("/home/u");
        assert_eq!(
            expand(home, "~/.agents/skills"),
            home.join(".agents/skills")
        );
        assert_eq!(
            expand(home, "${HOME}/.agents/skills/"),
            home.join(".agents/skills")
        );
        assert_eq!(expand(home, "$HOME/x"), home.join("x"));
        assert_eq!(expand(home, "skills"), home.join(".hermes/skills"));
        assert_eq!(expand(home, "/abs"), PathBuf::from("/abs"));
        let (_dir, machine) = home_with("skills:\n  external_dirs: '~/.agents/skills'\n");
        assert!(lists_shared_dir(&machine));
        let (_dir, machine) = home_with("skills:\n  external_dirs: [/team/skills]\n");
        assert!(!lists_shared_dir(&machine));
    }
}
