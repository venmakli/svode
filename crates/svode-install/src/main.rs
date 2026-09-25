//! `svode-launcher`. Copied to `~/.svode/bin/svode` and `~/.svode/bin/svode-mcp`
//! it runs that binary of the active runtime; under its own name it is the
//! standalone installer the install script calls from an unpacked archive.

#[cfg(unix)]
fn main() {
    let mut args = std::env::args_os();
    let program = args
        .next()
        .map(std::path::PathBuf::from)
        .and_then(|path| path.file_name()?.to_str().map(str::to_string))
        .unwrap_or_default();
    if svode_install::LAUNCHERS.contains(&program.as_str()) {
        unix::launch(&program, args);
    }
    let args = args
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    std::process::exit(unix::installer(&args));
}

#[cfg(not(unix))]
fn main() {
    eprintln!("svode-launcher: the stable location is supported on macOS and Linux only");
    std::process::exit(1);
}

#[cfg(unix)]
mod unix {
    use std::ffi::OsString;
    use std::os::unix::process::CommandExt;
    use std::path::Path;
    use std::process::Command;

    use svode_install::shell_path::{self, PathEntry, Shell};
    use svode_install::{
        InstallError, Layout, RuntimeKind, RuntimeRecord, StandaloneInstall, StandaloneRemoval,
        Unavailable, VERSION, diagnostic, install_standalone, resolve_launch, uninstall_standalone,
    };

    /// Runs `name` of the active runtime with `args`. When that is not
    /// possible, `svode` reports why and exits 69 (EX_UNAVAILABLE), and
    /// `svode-mcp` serves the reason as an MCP server.
    pub fn launch(name: &str, args: impl Iterator<Item = OsString>) -> ! {
        let unavailable = match Layout::user() {
            Err(error) => Unavailable::from_error(&error),
            Ok(layout) => match resolve_launch(&layout, name) {
                Err(unavailable) => unavailable,
                Ok(binary) => {
                    let error = Command::new(&binary).args(args).exec();
                    Unavailable::start_failed(&binary, &error)
                }
            },
        };
        if name == "svode-mcp" {
            diagnostic::serve(&unavailable);
            std::process::exit(0);
        }
        eprintln!(
            "{name}: {}\n  hint: {}",
            unavailable.message, unavailable.hint
        );
        std::process::exit(69);
    }

    const USAGE: &str = "Usage:
  svode-launcher install     Install or update the standalone Svode runtime this
                             binary belongs to (the unpacked archive around it)
  svode-launcher uninstall   Remove the standalone Svode runtime
  svode-launcher --version";

    pub fn installer(args: &[String]) -> i32 {
        let result = match args.iter().map(String::as_str).collect::<Vec<_>>()[..] {
            ["install"] => install(),
            ["uninstall"] => uninstall(),
            ["--version" | "-V"] => {
                println!("svode-launcher {VERSION}");
                return 0;
            }
            ["--help" | "-h"] => {
                println!("{USAGE}");
                return 0;
            }
            _ => {
                eprintln!("{USAGE}");
                return 2;
            }
        };
        match result {
            Ok(report) => {
                println!("{report}");
                0
            }
            Err(error) => {
                eprintln!("error[{}]: {}", error.code, error.message);
                1
            }
        }
    }

    fn install() -> Result<String, InstallError> {
        let exe = std::env::current_exe()
            .and_then(|exe| exe.canonicalize())
            .map_err(|error| InstallError::new("INSTALL_IO_ERROR", error.to_string()))?;
        let source = exe.parent().and_then(Path::parent).ok_or_else(|| {
            InstallError::new(
                "INVALID_RUNTIME",
                "run the installer from an unpacked Svode archive",
            )
        })?;
        let layout = Layout::user()?;
        let launchers = launchers(&layout);
        let mut report = match install_standalone(&layout, source, VERSION)? {
            StandaloneInstall::Active { previous } => format!(
                "Installed the standalone Svode runtime {VERSION}{}; it is the active runtime.\n{launchers}",
                replaced(previous.as_ref())
            ),
            StandaloneInstall::UpdatedInactive { desktop } => format!(
                "Updated the standalone Svode runtime to {VERSION}. Svode Desktop {desktop} is installed and stays the active runtime; the standalone runtime takes over when Svode Desktop is removed.\n{launchers}"
            ),
            StandaloneInstall::DesktopRuntime { desktop } => format!(
                "Svode Desktop {desktop} is installed, so its runtime stays active and the standalone runtime was not installed.\n{launchers}"
            ),
        };
        report.push('\n');
        report.push_str(&path_report(&shell_path::add(&Shell {
            home: home(&layout),
            shell: std::env::var_os("SHELL").as_deref(),
            zdotdir: std::env::var_os("ZDOTDIR").as_deref(),
            path: std::env::var_os("PATH").as_deref(),
        })?));
        Ok(report)
    }

    fn uninstall() -> Result<String, InstallError> {
        let layout = Layout::user()?;
        let mut report = match uninstall_standalone(&layout)? {
            StandaloneRemoval::Active => format!(
                "Removed the standalone Svode runtime and its launchers ({}).",
                layout.root().display()
            ),
            StandaloneRemoval::Inactive { desktop } => format!(
                "Removed the standalone Svode runtime. Svode Desktop {desktop} stays the active runtime with its launchers."
            ),
            StandaloneRemoval::NotInstalled { desktop } => format!(
                "No standalone Svode runtime is installed; Svode Desktop {desktop} stays the active runtime with its launchers."
            ),
            StandaloneRemoval::Nothing => "No Svode runtime is installed.".to_string(),
        };
        let zdotdir = std::env::var_os("ZDOTDIR");
        for file in shell_path::remove(home(&layout), zdotdir.as_deref())? {
            report.push_str(&format!(
                "\nRemoved ~/.svode/bin from PATH in {}.",
                file.display()
            ));
        }
        Ok(report)
    }

    fn home(layout: &Layout) -> &Path {
        layout.root().parent().unwrap_or(layout.root())
    }

    fn launchers(layout: &Layout) -> String {
        format!(
            "Launchers: {} and {}.",
            layout.launcher("svode").display(),
            layout.launcher("svode-mcp").display()
        )
    }

    fn replaced(previous: Option<&RuntimeRecord>) -> String {
        previous
            .map(|record| {
                let kind = match record.kind {
                    RuntimeKind::Desktop => "Svode Desktop",
                    RuntimeKind::Standalone => "the standalone runtime",
                };
                format!(" in place of {kind} {}", record.version)
            })
            .unwrap_or_default()
    }

    fn path_report(entry: &PathEntry) -> String {
        match entry {
            PathEntry::Added(file) => format!(
                "Added ~/.svode/bin to PATH in {}. Open a new terminal, or run in this one:\n  export PATH=\"$HOME/.svode/bin:$PATH\"",
                file.display()
            ),
            PathEntry::Present(file) => {
                format!("~/.svode/bin is on PATH through {}.", file.display())
            }
            PathEntry::OnPath => "~/.svode/bin is already on PATH.".to_string(),
        }
    }
}
