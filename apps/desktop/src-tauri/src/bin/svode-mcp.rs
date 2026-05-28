#[tokio::main]
async fn main() {
    std::process::exit(svode_lib::mcp::cli::run_cli().await);
}
