//! Diagnostic log of the standalone `svode` and `svode-mcp` processes.
//!
//! Both write `tracing` events only to stderr, since stdout carries the CLI
//! result and the MCP stdio messages. Each process passes its own default
//! level: the short `svode` command logs warnings, the long `svode-mcp`
//! session also its lifecycle `info`.

use std::io::IsTerminal;

use tracing::Level;
use tracing_subscriber::EnvFilter;

/// Lib targets of the workspace crates `svode` and `svode-mcp` link as normal
/// dependencies, the binaries' own lib targets included. They log at the
/// level of their process; a target the process does not link stays silent.
/// A test keeps the list in step with the manifests.
const WORKSPACE_TARGETS: [&str; 6] = [
    "svode_cli",
    "svode_connect",
    "svode_core",
    "svode_install",
    "svode_mcp",
    "svode_tools",
];

/// The log filter of a standalone process. A valid `RUST_LOG` replaces it
/// entirely; an unset or invalid one gives the workspace crates `level` and
/// no third-party targets.
fn env_filter(rust_log: Option<&str>, level: Level) -> EnvFilter {
    rust_log
        .and_then(|directives| EnvFilter::try_new(directives).ok())
        .unwrap_or_else(|| {
            let directives = WORKSPACE_TARGETS
                .iter()
                .map(|target| format!("{target}={level}"))
                .collect::<Vec<_>>();
            EnvFilter::new(directives.join(","))
        })
}

/// Installs the stderr log of this process before any of its work. Lines
/// carry no ANSI escapes unless stderr is a terminal and `NO_COLOR` is unset
/// or empty; a failed write is dropped without changing the result.
pub fn init(level: Level) {
    let stderr = std::io::stderr();
    let no_color = std::env::var_os("NO_COLOR").is_some_and(|value| !value.is_empty());
    let _ = tracing_subscriber::fmt()
        .with_env_filter(env_filter(
            std::env::var(EnvFilter::DEFAULT_ENV).ok().as_deref(),
            level,
        ))
        .with_writer(std::io::stderr)
        .with_ansi(stderr.is_terminal() && !no_color)
        .log_internal_errors(false)
        .try_init();
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::path::Path;

    use tracing::{Metadata, Subscriber};
    use tracing_core::callsite::Callsite;
    use tracing_core::field::FieldSet;
    use tracing_core::metadata::Kind;
    use tracing_core::subscriber::Interest;
    use tracing_subscriber::layer::SubscriberExt;

    use super::*;

    struct TestCallsite;

    impl Callsite for TestCallsite {
        fn set_interest(&self, _: Interest) {}

        fn metadata(&self) -> &Metadata<'_> {
            unreachable!("the filter reads the metadata of each checked event")
        }
    }

    static CALLSITE: TestCallsite = TestCallsite;

    fn subscriber(rust_log: Option<&str>, level: Level) -> impl Subscriber {
        tracing_subscriber::registry().with(env_filter(rust_log, level))
    }

    /// Whether an event from a module of `krate` at `level` passes the filter.
    fn enabled(subscriber: &impl Subscriber, krate: &str, level: Level) -> bool {
        let target = format!("{krate}::module");
        let metadata = Metadata::new(
            "event",
            &target,
            level,
            None,
            None,
            Some(&target),
            FieldSet::new(&[], tracing_core::identify_callsite!(&CALLSITE)),
            Kind::EVENT,
        );
        subscriber.enabled(&metadata)
    }

    fn manifest(dir: &Path) -> toml::Table {
        let text = std::fs::read_to_string(dir.join("Cargo.toml")).unwrap();
        text.parse().unwrap()
    }

    fn lib_name(krate: &toml::Table) -> String {
        krate
            .get("lib")
            .and_then(|lib| lib.get("name")?.as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| krate["package"]["name"].as_str().unwrap().replace('-', "_"))
    }

    /// Lib names of the crate in `dir` and of every crate it reaches through
    /// path dependencies in `[dependencies]` and `[target.*.dependencies]`.
    fn workspace_graph(dir: &Path, targets: &mut BTreeSet<String>) {
        let krate = manifest(dir);
        if !targets.insert(lib_name(&krate)) {
            return;
        }
        let platform_tables = krate
            .get("target")
            .and_then(toml::Value::as_table)
            .into_iter()
            .flat_map(|targets| targets.values())
            .filter_map(|platform| platform.get("dependencies"));
        let paths = krate
            .get("dependencies")
            .into_iter()
            .chain(platform_tables)
            .filter_map(toml::Value::as_table)
            .flat_map(|dependencies| dependencies.values())
            .filter_map(|dependency| dependency.get("path")?.as_str())
            .map(|path| dir.join(path))
            .collect::<Vec<_>>();
        for path in paths {
            workspace_graph(&path, targets);
        }
    }

    /// Workspace lib targets in the normal dependency graph of a binary crate.
    fn binary_targets(krate: &str) -> BTreeSet<String> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(krate);
        let mut targets = BTreeSet::new();
        workspace_graph(&dir, &mut targets);
        targets
    }

    #[test]
    fn default_targets_are_the_workspace_graphs_of_both_binaries() {
        let cli = binary_targets("svode-cli");
        let mcp = binary_targets("svode-mcp");
        assert!(cli.contains("svode_cli") && cli.contains("svode_core"));
        assert!(mcp.contains("svode_mcp") && mcp.contains("svode_core"));
        let expected = WORKSPACE_TARGETS.iter().map(|t| t.to_string()).collect();
        assert_eq!(&cli | &mcp, expected);
    }

    #[test]
    fn default_filter_passes_the_process_level_of_its_workspace_graph() {
        for (krate, level, silent) in [
            (
                "svode-cli",
                Level::WARN,
                [Level::INFO, Level::DEBUG, Level::TRACE].as_slice(),
            ),
            (
                "svode-mcp",
                Level::INFO,
                [Level::DEBUG, Level::TRACE].as_slice(),
            ),
        ] {
            let targets = binary_targets(krate);
            for rust_log in [None, Some("svode_core=loud")] {
                let subscriber = subscriber(rust_log, level);
                for target in &targets {
                    for passing in [Level::ERROR, Level::WARN, Level::INFO]
                        .into_iter()
                        .filter(|passing| *passing <= level)
                    {
                        assert!(
                            enabled(&subscriber, target, passing),
                            "{krate} {target} {passing}"
                        );
                    }
                    for silent in silent {
                        assert!(
                            !enabled(&subscriber, target, *silent),
                            "{krate} {target} {silent}"
                        );
                    }
                }
                for third_party in ["sqlx", "tokio", "clap"] {
                    assert!(
                        !enabled(&subscriber, third_party, Level::ERROR),
                        "{krate} {third_party}"
                    );
                }
            }
        }
    }

    #[test]
    fn valid_rust_log_replaces_the_default_filter() {
        for level in [Level::WARN, Level::INFO] {
            let subscriber = subscriber(Some("svode_core=debug,sqlx=warn"), level);
            assert!(enabled(&subscriber, "svode_core", Level::DEBUG));
            assert!(enabled(&subscriber, "sqlx", Level::WARN));
            assert!(!enabled(&subscriber, "svode_tools", Level::ERROR));
            assert!(!enabled(&subscriber, "svode_cli", Level::ERROR));
        }
    }
}
