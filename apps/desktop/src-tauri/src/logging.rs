use std::io;
use std::path::Path;
use std::sync::OnceLock;

use tracing_appender::rolling::{RollingFileAppender, RollingWriter, Rotation};
use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt::writer::{EitherWriter, MakeWriter};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

const LOG_FILE_PREFIX: &str = "svode";
const LOG_FILE_SUFFIX: &str = "log";
/// Daily files of the last week stay in the log directory.
const KEPT_LOG_FILES: usize = 7;

/// The daily log files, opened once the app knows its log directory.
static LOG_FILES: OnceLock<RollingFileAppender> = OnceLock::new();

/// Lib targets of the workspace crates Desktop links as normal dependencies.
/// Their `info` and above reach the default log; a test keeps the list in
/// step with `Cargo.toml`.
const WORKSPACE_TARGETS: [&str; 7] = [
    "svode_agents",
    "svode_connect",
    "svode_core",
    "svode_install",
    "svode_mcp",
    "svode_speech",
    "svode_tools",
];

fn default_directives() -> String {
    std::iter::once("svode_lib=debug".to_owned())
        .chain(
            WORKSPACE_TARGETS
                .iter()
                .map(|target| format!("{target}=info")),
        )
        .collect::<Vec<_>>()
        .join(",")
}

/// The Desktop log filter. A valid `RUST_LOG` replaces it entirely; an unset
/// or invalid one gives Desktop `debug`, workspace crates `info` and no
/// third-party targets.
fn env_filter(rust_log: Option<&str>) -> EnvFilter {
    rust_log
        .and_then(|directives| EnvFilter::try_new(directives).ok())
        .unwrap_or_else(|| EnvFilter::new(default_directives()))
}

/// Desktop events go to stdout and, once [`open_log_files`] succeeds, to the
/// log files too: a release build on Windows has no console, so a file is the
/// only trace a crash leaves. Files are written without buffering, so the
/// last lines before an abort are kept.
pub(crate) fn init() {
    let rust_log = std::env::var(EnvFilter::DEFAULT_ENV).ok();
    tracing_subscriber::registry()
        .with(env_filter(rust_log.as_deref()))
        .with(tracing_subscriber::fmt::layer())
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(LogFiles),
        )
        .init();
    log_panics();
}

/// Start writing the log into daily files of `dir`. A failure leaves the
/// log on stdout alone.
pub(crate) fn open_log_files(dir: &Path) {
    match daily_log_files(dir) {
        Ok(files) => {
            if LOG_FILES.set(files).is_ok() {
                tracing::info!(dir = %dir.display(), "writing the log to files");
            }
        }
        Err(error) => {
            tracing::warn!(dir = %dir.display(), %error, "the log files did not open");
        }
    }
}

fn daily_log_files(
    dir: &Path,
) -> Result<RollingFileAppender, tracing_appender::rolling::InitError> {
    RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix(LOG_FILE_PREFIX)
        .filename_suffix(LOG_FILE_SUFFIX)
        .max_log_files(KEPT_LOG_FILES)
        .build(dir)
}

/// Panics reach the log with their backtrace before the default hook prints
/// them.
fn log_panics() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        tracing::error!(target: "svode_lib::panic", "{info}\n{backtrace}");
        default_hook(info);
    }));
}

/// The writer of the file layer: the log files once open, nothing before.
struct LogFiles;

impl<'a> MakeWriter<'a> for LogFiles {
    type Writer = EitherWriter<RollingWriter<'a>, io::Sink>;

    fn make_writer(&'a self) -> Self::Writer {
        match LOG_FILES.get() {
            Some(files) => EitherWriter::A(files.make_writer()),
            None => EitherWriter::B(io::sink()),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::path::Path;

    use tracing::{Level, Metadata, Subscriber};
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

    fn subscriber(rust_log: Option<&str>) -> impl Subscriber {
        tracing_subscriber::registry().with(env_filter(rust_log))
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

    /// Lib names of the path dependencies in `[dependencies]` and every
    /// `[target.*.dependencies]` of the Desktop manifest.
    fn workspace_dependency_targets() -> BTreeSet<String> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let desktop = manifest(dir);
        let platform_tables = desktop
            .get("target")
            .and_then(toml::Value::as_table)
            .into_iter()
            .flat_map(|targets| targets.values())
            .filter_map(|platform| platform.get("dependencies"));
        desktop
            .get("dependencies")
            .into_iter()
            .chain(platform_tables)
            .filter_map(toml::Value::as_table)
            .flat_map(|dependencies| dependencies.values())
            .filter_map(|dependency| dependency.get("path")?.as_str())
            .map(|path| {
                let krate = manifest(&dir.join(path));
                let lib_name = krate
                    .get("lib")
                    .and_then(|lib| lib.get("name")?.as_str())
                    .map(str::to_owned);
                lib_name
                    .unwrap_or_else(|| krate["package"]["name"].as_str().unwrap().replace('-', "_"))
            })
            .collect()
    }

    #[test]
    fn log_files_are_daily_svode_logs_in_a_created_log_directory() {
        use std::io::Write;

        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("logs");
        let files = daily_log_files(&dir).unwrap();
        files.make_writer().write_all(b"line\n").unwrap();
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names.len(), 1, "{names:?}");
        assert!(
            names[0].starts_with("svode.") && names[0].ends_with(".log"),
            "{names:?}"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join(&names[0])).unwrap(),
            "line\n"
        );
    }

    #[test]
    fn default_targets_are_the_workspace_dependencies_of_desktop() {
        let expected: BTreeSet<String> = WORKSPACE_TARGETS.iter().map(|t| t.to_string()).collect();
        assert_eq!(workspace_dependency_targets(), expected);
    }

    #[test]
    fn default_filter_passes_info_of_workspace_crates_and_debug_of_desktop() {
        let targets = workspace_dependency_targets();
        assert!(targets.contains("svode_core"));
        for rust_log in [None, Some("svode_core=loud")] {
            let subscriber = subscriber(rust_log);
            for target in &targets {
                for level in [Level::ERROR, Level::WARN, Level::INFO] {
                    assert!(enabled(&subscriber, target, level), "{target} {level}");
                }
                for level in [Level::DEBUG, Level::TRACE] {
                    assert!(!enabled(&subscriber, target, level), "{target} {level}");
                }
            }
            assert!(enabled(&subscriber, "svode_lib", Level::DEBUG));
            assert!(!enabled(&subscriber, "svode_lib", Level::TRACE));
            for third_party in ["tao", "sqlx"] {
                assert!(!enabled(&subscriber, third_party, Level::ERROR));
            }
        }
    }

    #[test]
    fn valid_rust_log_replaces_the_default_filter() {
        let subscriber = subscriber(Some("svode_core=debug,tao=warn"));
        assert!(enabled(&subscriber, "svode_core", Level::DEBUG));
        assert!(enabled(&subscriber, "tao", Level::WARN));
        assert!(!enabled(&subscriber, "svode_lib", Level::ERROR));
        assert!(!enabled(&subscriber, "svode_tools", Level::ERROR));
    }
}
