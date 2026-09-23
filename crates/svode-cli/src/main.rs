use std::io::Write;

use svode_cli::{Rendered, parse, run, runtime_failure};
use svode_tools::standalone::StandaloneHost;

fn main() {
    let raw = std::env::args_os().collect::<Vec<_>>();
    let rendered = match parse(&raw) {
        Err(rendered) => rendered,
        Ok(cli) => {
            let cwd = std::env::current_dir().unwrap_or_default();
            let json = cli.json;
            match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime.block_on(async {
                    // The command owns its runtime: whatever it opened is
                    // closed before the process exits, also on a signal.
                    let host = StandaloneHost::new(env!("CARGO_PKG_VERSION"));
                    let outcome = tokio::select! {
                        rendered = run(&host, cli, &cwd) => Ok(rendered),
                        signal = shutdown_signal() => Err(signal),
                    };
                    host.close().await;
                    match outcome {
                        Ok(rendered) => rendered,
                        Err(signal) => Rendered {
                            stdout: String::new(),
                            stderr: String::new(),
                            exit: 128 + signal,
                        },
                    }
                }),
                Err(error) => runtime_failure(error, json),
            }
        }
    };
    // A closed pipe on the reader side is not a command failure.
    let mut out = std::io::stdout().lock();
    let _ = out
        .write_all(rendered.stdout.as_bytes())
        .and_then(|()| out.flush());
    eprint!("{}", rendered.stderr);
    std::process::exit(rendered.exit);
}

/// Number of the first SIGINT or SIGTERM the process receives.
async fn shutdown_signal() -> i32 {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let (Ok(mut interrupt), Ok(mut terminate)) = (
            signal(SignalKind::interrupt()),
            signal(SignalKind::terminate()),
        ) else {
            return std::future::pending().await;
        };
        tokio::select! {
            _ = interrupt.recv() => 2,
            _ = terminate.recv() => 15,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
        2
    }
}
