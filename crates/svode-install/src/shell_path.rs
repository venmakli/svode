//! Access to `svode` in the user's own terminal: the standalone installer
//! adds `~/.svode/bin` to PATH in the startup file of the login shell, the
//! way other user-level installers do, and removes exactly that entry.

use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::InstallError;

const MARKER: &str = "# Svode runtime, added by the Svode installer";
const EXPORT: &str = "export PATH=\"$HOME/.svode/bin:$PATH\"";
const FISH: &str =
    "# Svode runtime, added by the Svode installer\nset -gx PATH $HOME/.svode/bin $PATH\n";
const FISH_FILE: &str = ".config/fish/conf.d/svode.fish";

/// The PATH entry after [`add`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathEntry {
    /// Written now into this file; new terminals find `svode`.
    Added(PathBuf),
    /// Written by an earlier install into this file.
    Present(PathBuf),
    /// The user's PATH already contains the launchers directory.
    OnPath,
}

/// The user's shell environment the entry is written for.
#[derive(Debug, Clone, Copy)]
pub struct Shell<'a> {
    pub home: &'a Path,
    /// `$SHELL`, the login shell.
    pub shell: Option<&'a OsStr>,
    /// `$ZDOTDIR` of zsh.
    pub zdotdir: Option<&'a OsStr>,
    /// `$PATH` of the installer process.
    pub path: Option<&'a OsStr>,
}

impl Shell<'_> {
    /// The startup file of the login shell that new terminals read.
    fn profile(&self) -> PathBuf {
        let name = self
            .shell
            .map(Path::new)
            .and_then(Path::file_name)
            .and_then(OsStr::to_str)
            .unwrap_or("");
        match name {
            "zsh" => self.zdotdir.map_or(self.home, Path::new).join(".zshrc"),
            "bash" if cfg!(target_os = "macos") => self.home.join(".bash_profile"),
            "bash" => self.home.join(".bashrc"),
            "fish" => self.home.join(FISH_FILE),
            _ => self.home.join(".profile"),
        }
    }

    fn bin(&self) -> PathBuf {
        self.home.join(".svode/bin")
    }
}

/// Makes `~/.svode/bin` reachable from new terminals of the user.
pub fn add(shell: &Shell<'_>) -> Result<PathEntry, InstallError> {
    let profile = shell.profile();
    let content = fs::read_to_string(&profile).unwrap_or_default();
    let fish = profile.ends_with(FISH_FILE);
    if (fish && content == FISH) || (!fish && has_entry(&content)) {
        return Ok(PathEntry::Present(profile));
    }
    let bin = shell.bin();
    if shell
        .path
        .is_some_and(|path| std::env::split_paths(path).any(|dir| dir == bin))
    {
        return Ok(PathEntry::OnPath);
    }
    if let Some(dir) = profile.parent() {
        fs::create_dir_all(dir).map_err(|error| InstallError::io(dir, error))?;
    }
    let entry = if fish {
        FISH.to_string()
    } else {
        let separator = if content.is_empty() || content.ends_with("\n\n") {
            ""
        } else if content.ends_with('\n') {
            "\n"
        } else {
            "\n\n"
        };
        format!("{separator}{MARKER}\n{EXPORT}\n")
    };
    // Appending keeps a startup file that is a link into a dotfiles repo.
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&profile)
        .and_then(|mut file| file.write_all(entry.as_bytes()))
        .map_err(|error| InstallError::io(&profile, error))?;
    Ok(PathEntry::Added(profile))
}

/// Removes the entry [`add`] wrote from every startup file it may be in and
/// returns the files changed. Other content stays byte for byte.
pub fn remove(home: &Path, zdotdir: Option<&OsStr>) -> Result<Vec<PathBuf>, InstallError> {
    let mut changed = Vec::new();
    let fish = home.join(FISH_FILE);
    if fs::read_to_string(&fish).is_ok_and(|content| content == FISH) {
        fs::remove_file(&fish).map_err(|error| InstallError::io(&fish, error))?;
        changed.push(fish);
    }
    let zsh = zdotdir.map_or(home, Path::new).join(".zshrc");
    for profile in [
        zsh,
        home.join(".bash_profile"),
        home.join(".bashrc"),
        home.join(".profile"),
    ] {
        let Ok(content) = fs::read_to_string(&profile) else {
            continue;
        };
        let without = without_entry(&content);
        if without != content {
            // Written in place, so a linked startup file stays a link.
            fs::write(&profile, without).map_err(|error| InstallError::io(&profile, error))?;
            changed.push(profile);
        }
    }
    Ok(changed)
}

fn has_entry(content: &str) -> bool {
    let lines = content.lines().collect::<Vec<_>>();
    lines.windows(2).any(|pair| pair == [MARKER, EXPORT])
}

/// `content` without the marker and export lines, and without the blank
/// line that [`add`] put before them.
fn without_entry(content: &str) -> String {
    let lines = content.split_inclusive('\n').collect::<Vec<_>>();
    let mut kept: Vec<&str> = Vec::with_capacity(lines.len());
    let mut index = 0;
    while index < lines.len() {
        let is_entry = lines[index].trim_end_matches('\n') == MARKER
            && lines
                .get(index + 1)
                .is_some_and(|next| next.trim_end_matches('\n') == EXPORT);
        if is_entry {
            if kept.last() == Some(&"\n") {
                kept.pop();
            }
            index += 2;
        } else {
            kept.push(lines[index]);
            index += 1;
        }
    }
    kept.concat()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell<'a>(home: &'a Path, name: &'a str, path: Option<&'a OsStr>) -> Shell<'a> {
        Shell {
            home,
            shell: Some(OsStr::new(name)),
            zdotdir: None,
            path,
        }
    }

    #[test]
    fn adds_one_entry_to_the_startup_file_of_the_login_shell_and_removes_only_it() {
        let home = tempfile::tempdir().unwrap();
        let zshrc = home.path().join(".zshrc");
        fs::write(&zshrc, "alias ll='ls -l'").unwrap();
        let zsh = shell(home.path(), "/bin/zsh", None);

        assert_eq!(add(&zsh).unwrap(), PathEntry::Added(zshrc.clone()));
        assert_eq!(add(&zsh).unwrap(), PathEntry::Present(zshrc.clone()));
        assert_eq!(
            fs::read_to_string(&zshrc).unwrap(),
            format!("alias ll='ls -l'\n\n{MARKER}\n{EXPORT}\n")
        );

        assert_eq!(remove(home.path(), None).unwrap(), vec![zshrc.clone()]);
        assert_eq!(fs::read_to_string(&zshrc).unwrap(), "alias ll='ls -l'\n");
        assert!(remove(home.path(), None).unwrap().is_empty());
    }

    #[test]
    fn a_path_that_already_has_the_launchers_is_left_alone() {
        let home = tempfile::tempdir().unwrap();
        let path =
            std::env::join_paths([home.path().join(".svode/bin"), "/usr/bin".into()]).unwrap();
        let bash = shell(home.path(), "/bin/bash", Some(&path));
        assert_eq!(add(&bash).unwrap(), PathEntry::OnPath);
        assert!(!home.path().join(".bashrc").exists());
        assert!(!home.path().join(".bash_profile").exists());
    }

    #[test]
    fn fish_gets_its_own_file_and_unknown_shells_the_profile() {
        let home = tempfile::tempdir().unwrap();
        let fish = home.path().join(FISH_FILE);
        assert_eq!(
            add(&shell(home.path(), "/usr/bin/fish", None)).unwrap(),
            PathEntry::Added(fish.clone())
        );
        assert_eq!(fs::read_to_string(&fish).unwrap(), FISH);
        let profile = home.path().join(".profile");
        assert_eq!(
            add(&shell(home.path(), "/bin/dash", None)).unwrap(),
            PathEntry::Added(profile.clone())
        );
        assert_eq!(
            fs::read_to_string(&profile).unwrap(),
            format!("{MARKER}\n{EXPORT}\n")
        );

        let mut removed = remove(home.path(), None).unwrap();
        removed.sort();
        assert_eq!(removed, {
            let mut expected = vec![fish.clone(), profile.clone()];
            expected.sort();
            expected
        });
        assert!(!fish.exists());
        assert_eq!(fs::read_to_string(&profile).unwrap(), "");
    }

    #[test]
    fn a_changed_entry_belongs_to_the_user() {
        let content = format!("{MARKER}\nexport PATH=\"$HOME/.svode/bin:$HOME/bin:$PATH\"\n");
        assert_eq!(without_entry(&content), content);
        assert!(!has_entry(&content));
    }
}
