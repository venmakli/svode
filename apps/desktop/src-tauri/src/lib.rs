mod commands;
mod error;

pub use error::AppError;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "combai_desktop_lib=debug".into()),
        )
        .init();

    tracing::info!("Starting CombAI desktop app");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![commands::greet::greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
