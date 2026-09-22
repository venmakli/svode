//! Closing audit of the command map: every data and guidance capability of
//! the shared catalog has exactly one public command, the command table
//! covers the whole grammar, and the command reference matches both.

mod common;

use std::collections::{BTreeMap, BTreeSet};

use common::commands::{CASES, argv, fixture, leaf_commands};
use common::harness::{Access, WriteHost, svode};
use svode_cli::host::SourceHost;
use svode_tools::catalog;
use svode_tools::host::ToolHost;

/// Capability waiting for G04; it has no command and no help entry.
const RUN_ROUTINE: &str = "run_routine";

fn catalog_tools() -> BTreeSet<String> {
    catalog::definitions()
        .into_iter()
        .map(|definition| definition.name.to_string())
        .collect()
}

/// command → catalog tools, from the command table.
fn table_map() -> BTreeMap<String, BTreeSet<String>> {
    let mut map = BTreeMap::<String, BTreeSet<String>>::new();
    for case in CASES {
        map.entry(case.name.to_string())
            .or_default()
            .extend(case.tools.iter().map(|tool| tool.to_string()));
    }
    map
}

#[test]
fn command_table_covers_every_leaf_command_of_the_grammar() {
    let leaves = leaf_commands().into_iter().collect::<BTreeSet<_>>();
    let table = table_map().into_keys().collect::<BTreeSet<_>>();
    assert_eq!(leaves, table);
    assert!(!leaves.iter().any(|leaf| leaf.starts_with("routine run")));
}

/// Each invocation runs through the public frame on a host that records
/// what it is asked to serve and denies repository access, so no mutation
/// writes anything. Every capability except `run_routine` is asked for by
/// exactly one command, and every command asks for its own tools only.
#[tokio::test]
async fn every_catalog_capability_has_exactly_one_command() {
    let fixture = fixture();
    let host = WriteHost::new(Access::Deny);
    let mut owner = BTreeMap::<String, &str>::new();
    for case in CASES {
        let (exit, value) = svode(&host, &fixture.input, &argv(&fixture, case)).await;
        assert!(exit == 0 || exit == 1, "{}: {value}", case.name);
        let asked = host.take_asked();
        let expected = case
            .tools
            .iter()
            .map(|tool| tool.to_string())
            .collect::<BTreeSet<_>>();
        if case.name == "doctor" {
            // Diagnostics own no capability: they probe which tools the
            // host serves to report `runtime.servedTools`.
            assert_eq!(asked, catalog_tools(), "{asked:?}");
            continue;
        }
        assert_eq!(asked, expected, "{}", case.name);
        for tool in case.tools {
            if let Some(previous) = owner.insert(tool.to_string(), case.name) {
                panic!("{tool} has two commands: {previous} and {}", case.name);
            }
        }
    }
    // `page read` keeps the source-only read of `read_page` from Slice 4.1
    // and asks the host nothing.
    assert!(owner.insert("read_page".into(), "page read").is_none());
    let mut expected = catalog_tools();
    expected.remove(RUN_ROUTINE);
    assert_eq!(owner.keys().cloned().collect::<BTreeSet<_>>(), expected);
    assert_eq!(expected.len(), 53);
}

/// Rows of the command table in COMMANDS.md: command, capabilities and
/// the standalone column.
fn reference_rows() -> Vec<(String, BTreeSet<String>, bool)> {
    let reference = include_str!("../COMMANDS.md");
    let tools = catalog_tools();
    reference
        .lines()
        .filter(|line| line.starts_with("| `"))
        .filter_map(|line| {
            let cells = line
                .trim_matches('|')
                .split(" | ")
                .map(str::trim)
                .collect::<Vec<_>>();
            if cells.len() != 3 {
                return None;
            }
            let usage = cells[0].trim_matches('`');
            let name = usage
                .split_whitespace()
                .take_while(|word| !word.starts_with(['-', '<', '[']))
                .collect::<Vec<_>>()
                .join(" ");
            let capabilities = cells[1]
                .split('`')
                .skip(1)
                .step_by(2)
                .filter(|word| tools.contains(*word))
                .map(str::to_string)
                .collect();
            Some((name, capabilities, cells[2].starts_with("yes")))
        })
        .collect()
}

#[test]
fn command_reference_matches_the_catalog_the_grammar_and_the_standalone_host() {
    let rows = reference_rows();
    let mut reference = BTreeMap::<String, BTreeSet<String>>::new();
    for (name, capabilities, standalone) in &rows {
        reference
            .entry(name.clone())
            .or_default()
            .extend(capabilities.iter().cloned());
        let served = CASES
            .iter()
            .filter(|case| case.name == name)
            .flat_map(|case| case.tools)
            .all(|tool| SourceHost.serves_tool(tool));
        assert_eq!(*standalone, served, "standalone column of `{name}`");
    }
    // `page read` is the source-only read of `read_page`, `doctor` owns no
    // capability; every other command lists exactly its tools.
    let mut table = table_map();
    table
        .get_mut("page read")
        .unwrap()
        .insert("read_page".into());
    assert_eq!(reference, table);

    let mut documented = reference.into_values().flatten().collect::<BTreeSet<_>>();
    documented.insert(RUN_ROUTINE.into());
    assert_eq!(documented, catalog_tools());
}
