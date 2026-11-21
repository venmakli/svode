use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result, ensure};

fn temporary_directory(repo: &Path) -> Result<PathBuf> {
    let mut command = Command::new("git");
    svode_core::git::cli::configure_std_process_env(&mut command, Some(repo));
    command
        .args(["rev-parse", "--absolute-git-dir"])
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = command.output().context("resolving Git directory")?;
    // Do not forward arbitrary Git diagnostics into the transfer protocol.
    ensure!(output.status.success(), "cannot resolve Git directory");
    let stdout = String::from_utf8(output.stdout).context("non-utf8 Git directory")?;
    let directory = stdout.strip_suffix('\n').unwrap_or(&stdout);
    let directory = directory.strip_suffix('\r').unwrap_or(directory);
    let directory = PathBuf::from(directory);
    ensure!(directory.is_absolute(), "Git directory is not absolute");
    Ok(directory.join("lfs/tmp/svode-lfs"))
}

/// Writes the object into a new file Git LFS takes over, chunk by chunk as
/// `chunks` yields them; a failed chunk or write leaves no file behind.
pub(super) fn stage<B: AsRef<[u8]>>(
    repo: &Path,
    chunks: impl IntoIterator<Item = Result<B>>,
) -> Result<String> {
    let directory = temporary_directory(repo)?;
    std::fs::create_dir_all(&directory).context("creating LFS download directory")?;
    let mut file =
        tempfile::NamedTempFile::new_in(directory).context("creating LFS download file")?;
    let path = file
        .path()
        .to_str()
        .context("non-utf8 temp path")?
        .to_owned();
    for chunk in chunks {
        file.write_all(chunk?.as_ref())
            .context("writing LFS download file")?;
    }
    file.flush().context("flushing LFS download file")?;
    // Close before handing ownership to Git LFS; failed writes retain RAII cleanup.
    file.into_temp_path()
        .keep()
        .context("keeping LFS download file")?;
    Ok(path)
}

#[cfg(test)]
#[path = "download_tests.rs"]
mod tests;
