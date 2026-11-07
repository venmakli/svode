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

/// Scoped path, the `sourceVersion` line, a blank line and the body of the
/// source under `key` of one read result.
pub fn source(value: &Value, key: &str) -> String {
    let entry = &value[key];
    let body = text(&entry["body"]);
    let mut out = format!(
        "{}\nsourceVersion: {}\n\n{body}",
        text(&entry["path"]),
        text(&value["sourceVersion"])
    );
    if !body.is_empty() && !body.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// Warnings of a read source (malformed frontmatter, a title shared with
/// another Page) for stderr; the JSON result keeps them in the source.
pub fn source_warnings(value: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for key in ["page", "item", "spaceReadme", "collectionReadme", "readme"] {
        let entry = &value[key];
        for warning in entry["warnings"].as_array().into_iter().flatten() {
            out.push(format!(
                "warning[{}]: {}",
                text(&warning["kind"]),
                text(&warning["message"])
            ));
        }
        if let Some(conflicts) = entry["name_conflict"]["conflicts"].as_array() {
            let paths = conflicts
                .iter()
                .map(|conflict| text(&conflict["path"]))
                .collect::<Vec<_>>()
                .join(", ");
            out.push(format!(
                "warning[name_conflict]: Page title is also used by: {paths}"
            ));
        }
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

/// `reference<TAB>name<TAB>ownerSpaceId` per agent, then
/// `diagnostic code ownerSpaceId [reference]: message` per catalog
/// diagnostic.
pub fn agent_actors(value: &Value) -> String {
    let agents = value["agents"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|agent| {
            format!(
                "{}\t{}\t{}",
                text(&agent["reference"]),
                text(&agent["name"]),
                text(&agent["ownerSpaceId"])
            )
        });
    let diagnostics = value["diagnostics"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|diagnostic| {
            let reference = diagnostic["reference"]
                .as_str()
                .map(|reference| format!(" {reference}"))
                .unwrap_or_default();
            format!(
                "diagnostic {} {}{reference}: {}",
                text(&diagnostic["code"]),
                text(&diagnostic["ownerSpaceId"]),
                text(&diagnostic["message"])
            )
        });
    lines(agents.chain(diagnostics))
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

/// Validity and runtime type of an App manifest with its Settings
/// references, or `code path: message` per diagnostic.
pub fn manifest(value: &Value) -> String {
    if value["valid"] == true {
        let references = value["settingsReferences"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|reference| format!("setting {}", text(reference)));
        return lines(
            std::iter::once(format!("valid {} App", text(&value["runtimeType"]))).chain(references),
        );
    }
    let diagnostics = value["diagnostics"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|diagnostic| {
            format!(
                "{} {}: {}",
                text(&diagnostic["code"]),
                text(&diagnostic["path"]),
                text(&diagnostic["message"])
            )
        });
    lines(std::iter::once("invalid".to_string()).chain(diagnostics))
}

/// One line per App: owner path, runtime type or `invalid`, README presence.
pub fn apps(value: &Value) -> String {
    if value["apps"].as_array().is_none_or(Vec::is_empty) {
        return "no Apps\n".to_string();
    }
    lines(value["apps"].as_array().into_iter().flatten().map(|app| {
        let runtime = if app["valid"] == true {
            text(&app["runtimeType"]).to_string()
        } else {
            format!("invalid ({} diagnostics)", app["diagnosticCount"])
        };
        let readme = if app["hasReadme"] == true {
            "readme"
        } else {
            "no readme"
        };
        format!("{}\t{runtime}\t{readme}", text(&app["ownerPath"]))
    }))
}

/// App header, manifest diagnostics, then the README path and body.
pub fn app(value: &Value) -> String {
    let mut out = vec![text(&value["ownerPath"]).to_string()];
    if value["valid"] == true {
        out.push(format!("runtime: {}", text(&value["runtimeType"])));
    } else {
        out.push("runtime: invalid manifest".to_string());
    }
    if let Some(url) = value["url"].as_str() {
        out.push(format!("url: {url}"));
    }
    out.extend(
        value["diagnostics"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|diagnostic| {
                format!(
                    "{} {}: {}",
                    text(&diagnostic["code"]),
                    text(&diagnostic["path"]),
                    text(&diagnostic["message"])
                )
            }),
    );
    let readme = &value["readme"];
    if readme.is_null() {
        out.push("readme: none".to_string());
        return lines(out);
    }
    out.push(format!("readme: {}", text(&readme["path"])));
    if let Some(diagnostic) = readme["diagnostic"].as_object() {
        out.push(format!(
            "readme unreadable ({}): {}",
            diagnostic["code"].as_str().unwrap_or_default(),
            diagnostic["message"].as_str().unwrap_or_default()
        ));
        return lines(out);
    }
    let mut rendered = lines(out);
    rendered.push('\n');
    let body = text(&readme["body"]);
    rendered.push_str(body);
    if !body.is_empty() && !body.ends_with('\n') {
        rendered.push('\n');
    }
    if readme["truncated"] == true {
        rendered.push_str("[truncated: read the full README from its path]\n");
    }
    rendered
}

/// Canonical paths of an imported asset, then the changed paths.
pub fn import(value: &Value) -> String {
    let mut out = format!(
        "contentPath {}\nattachmentPath {}\nmarkdownUrl {}\n",
        text(&value["contentPath"]),
        text(&value["attachmentPath"]),
        text(&value["markdownUrl"])
    );
    if let Some(cover) = value["coverPath"].as_str() {
        out.push_str(&format!("coverPath {cover}\n"));
    }
    out + &changes(value)
}

/// `routineId<TAB>name<TAB>trigger<TAB>enabled|disabled|invalid<TAB>fingerprint`
/// per Routine; an invalid definition shows its path in place of an id.
pub fn routines(value: &Value) -> String {
    lines(
        value["routines"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|routine| {
                let state = if routine["valid"] != true {
                    "invalid"
                } else if routine["enabled"] == true {
                    "enabled"
                } else {
                    "disabled"
                };
                format!(
                    "{}\t{}\t{}\t{state}\t{}",
                    routine["routineId"]
                        .as_str()
                        .unwrap_or_else(|| text(&routine["path"])),
                    text(&routine["name"]),
                    text(&routine["triggerSummary"]),
                    text(&routine["fingerprint"])
                )
            }),
    )
}

/// Identity and new fingerprint of a changed Routine, then the changed
/// paths.
pub fn routine_change(value: &Value) -> String {
    let mut out = format!("routineId {}\n", text(&value["routineId"]));
    if let Some(fingerprint) = value["fingerprint"].as_str() {
        out.push_str(&format!("fingerprint {fingerprint}\n"));
    }
    out + &changes(value)
}

/// A created Space: its id, one line per repository with who commits the
/// creation, where settings change, then each changed path.
pub fn space_created(value: &Value) -> String {
    let mut out = format!("spaceId {}\n", text(&value["space"]["id"]));
    for repository in value["repositories"].as_array().into_iter().flatten() {
        let commit = &repository["commit"];
        let by = match commit["message"].as_str() {
            Some(message) => format!("commit by desktop: {message}"),
            None => format!("commit {}", text(&commit["by"])),
        };
        let created = if repository["created"] == true {
            " (new)"
        } else {
            ""
        };
        out.push_str(&format!(
            "repository {}{created}: {by}\n",
            text(&repository["path"])
        ));
    }
    out.push_str(&format!("settings {}\n", text(&value["settings"])));
    out + &changes(value)
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

/// `warning[kind]: message` per warning of an applied outcome; Routine
/// warnings name their `code`.
pub fn warnings(warnings: &Value) -> Vec<String> {
    warnings
        .as_array()
        .into_iter()
        .flatten()
        .map(|warning| {
            format!(
                "warning[{}]: {}",
                warning["kind"]
                    .as_str()
                    .unwrap_or_else(|| text(&warning["code"])),
                text(&warning["message"])
            )
        })
        .collect()
}
