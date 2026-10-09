//! Test infrastructure shared by the Svode crates, used only as a
//! dev-dependency.
//!
//! Tests of one binary run as threads of one process. When a thread writes an
//! executable file with `std::fs::write`, a process another thread spawns at
//! that moment inherits the open write descriptor until its `exec`, and Linux
//! refuses to run the file meanwhile with `ETXTBSY` ("Text file busy"). That
//! holds for the test itself and for every process that runs the file later:
//! git with its hooks, `core.sshCommand` or a Git LFS transfer agent.
//! [`write_executable`] never opens the file in the test process, so there is
//! no descriptor to inherit.
#![cfg(unix)]

use std::io::{self, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Stdio};

/// Creates or overwrites the executable file `path` with `contents` and mode
/// `0o755`.
///
/// A short-lived `sh` process writes the contents, which reach it through a
/// pipe; the test process only sets the permissions, so it never holds a
/// descriptor of the file a spawned process could inherit. The same path may
/// be overwritten again, also while nothing runs it.
pub fn write_executable(path: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> io::Result<()> {
    let path = path.as_ref();
    let mut writer = Command::new("/bin/sh")
        .args(["-c", "cat > \"$1\"", "sh"])
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    let written = writer
        .stdin
        .take()
        .expect("the writer's stdin is piped")
        .write_all(contents.as_ref());
    let output = writer.wait_with_output()?;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "writing {} failed with {}: {}",
            path.display(),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    written?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
}
