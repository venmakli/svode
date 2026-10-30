#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

#[tokio::main]
async fn main() {
    svode_tools::logging::init(tracing::Level::INFO);
    std::process::exit(svode_mcp::cli::run().await);
}
