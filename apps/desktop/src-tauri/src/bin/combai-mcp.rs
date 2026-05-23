#[tokio::main]
async fn main() {
    std::process::exit(combai_desktop_lib::mcp::cli::run_cli().await);
}
