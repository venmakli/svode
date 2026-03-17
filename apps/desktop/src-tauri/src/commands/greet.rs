#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! IPC is working.", name)
}
