use std::io::Write;

use svode_cli::host::SourceHost;
use svode_cli::{parse, run, runtime_failure};

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
                Ok(runtime) => runtime.block_on(run(&SourceHost, cli, &cwd)),
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
