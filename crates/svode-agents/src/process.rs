//! Child-process helpers shared by diagnostics and agent connections.

use tokio::process::Command;

#[cfg(windows)]
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

/// Keeps a console window from flashing up for a child of a GUI host.
pub(crate) fn hide_window(command: &mut Command) {
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// Lossy UTF-8 of at most `limit` bytes, trimmed.
pub(crate) fn bounded_text(bytes: &[u8], limit: usize) -> String {
    String::from_utf8_lossy(&bytes[..bytes.len().min(limit)])
        .trim()
        .to_string()
}
