//! Child-process helpers shared by diagnostics and agent connections.

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Keeps a console window from flashing up for a child of a GUI host.
pub(crate) fn hide_window(command: &mut tokio::process::Command) {
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
