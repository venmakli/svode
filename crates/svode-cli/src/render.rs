//! Human output of tool results. Its layout is not a public contract; only
//! the stdout/stderr split is.

use serde_json::Value;

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

fn title(item: &Value) -> &str {
    item["title"]
        .as_str()
        .or_else(|| item["meta"]["title"].as_str())
        .or_else(|| item["name"].as_str())
        .unwrap_or_default()
}

fn lines(lines: impl IntoIterator<Item = String>) -> String {
    lines.into_iter().map(|line| format!("{line}\n")).collect()
}

pub fn pretty(value: &Value) -> String {
    format!(
        "{}\n",
        serde_json::to_string_pretty(value).unwrap_or_default()
    )
}

/// Scoped path, a blank line and the body of one source read.
pub fn source(entry: &Value) -> String {
    let body = text(&entry["body"]);
    let mut out = format!("{}\n\n{body}", text(&entry["path"]));
    if !body.is_empty() && !body.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// `path<TAB>title` per entry.
pub fn rows(items: &Value) -> String {
    lines(
        items
            .as_array()
            .into_iter()
            .flatten()
            .map(|item| format!("{}\t{}", text(&item["path"]), title(item))),
    )
}

pub fn tree(value: &Value) -> String {
    fn walk(node: &Value, depth: usize, out: &mut Vec<String>) {
        out.push(format!(
            "{}{}\t{}",
            "  ".repeat(depth),
            text(&node["path"]),
            title(node)
        ));
        for child in node["children"].as_array().into_iter().flatten() {
            walk(child, depth + 1, out);
        }
    }
    let mut out = Vec::new();
    for node in value["items"].as_array().into_iter().flatten() {
        walk(node, 0, &mut out);
    }
    let shown = value["items"].as_array().map_or(0, Vec::len);
    let offset = value["offset"].as_u64().unwrap_or(0) as usize;
    let total = value["total"].as_u64().unwrap_or(0) as usize;
    if offset + shown < total {
        out.push(format!("… {shown} of {total} shown from offset {offset}"));
    }
    lines(out)
}

pub fn spaces(value: &Value) -> String {
    lines(
        value["spaces"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|space| {
                format!(
                    "{}\t{}\t{}\t{}",
                    text(&space["id"]),
                    text(&space["name"]),
                    text(&space["status"]),
                    text(&space["path"])
                )
            }),
    )
}

pub fn project(value: &Value) -> String {
    format!(
        "{}\n{}\n\n{}",
        text(&value["projectName"]),
        text(&value["projectPath"]),
        spaces(value)
    )
}

pub fn actors(value: &Value) -> String {
    lines(
        value["actors"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|actor| format!("{} <{}>", text(&actor["name"]), text(&actor["email"]))),
    )
}

/// Issue counts of an integrity check, then `severity code path: message`
/// per issue.
pub fn integrity(value: &Value) -> String {
    let report = &value["issuesBySeverity"];
    let issues = report["errors"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(report["warnings"].as_array().into_iter().flatten())
        .map(|issue| {
            format!(
                "{} {} {}: {}",
                text(&issue["severity"]),
                text(&issue["code"]),
                text(&issue["path"]),
                text(&issue["message"])
            )
        });
    lines(
        std::iter::once(format!(
            "{} errors, {} warnings",
            value["errorCount"], value["warningCount"]
        ))
        .chain(issues),
    )
}

/// Changed paths of a mutation, one per line.
pub fn changes(value: &Value) -> String {
    lines(
        value["changedPaths"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|path| text(path).to_string()),
    )
}

/// `warning[kind]: message` per warning of an applied outcome.
pub fn warnings(warnings: &Value) -> Vec<String> {
    warnings
        .as_array()
        .into_iter()
        .flatten()
        .map(|warning| {
            format!(
                "warning[{}]: {}",
                text(&warning["kind"]),
                text(&warning["message"])
            )
        })
        .collect()
}
