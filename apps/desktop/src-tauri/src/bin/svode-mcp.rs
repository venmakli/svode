#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

#[tokio::main]
async fn main() {
    std::process::exit(svode_lib::mcp::cli::run_cli().await);
}
