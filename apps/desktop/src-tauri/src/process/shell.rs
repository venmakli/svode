use std::path::Path;

pub(crate) fn login_shell() -> String {
    select_login_shell(std::env::var("SHELL").ok().as_deref(), |command| {
        if Path::new(command).is_absolute() {
            Path::new(command).is_file()
        } else {
            which::which(command).is_ok()
        }
    })
}

pub(crate) fn select_login_shell(env_shell: Option<&str>, exists: impl Fn(&str) -> bool) -> String {
    if let Some(shell) = env_shell.filter(|shell| !shell.trim().is_empty() && exists(shell)) {
        return shell.to_string();
    }
    ["/bin/zsh", "/bin/bash", "/bin/sh"]
        .into_iter()
        .find(|candidate| exists(candidate))
        .unwrap_or("/bin/sh")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unix_shell_prefers_valid_shell_env() {
        assert_eq!(
            select_login_shell(Some("/custom/zsh"), |candidate| candidate == "/custom/zsh"),
            "/custom/zsh",
        );
    }

    #[test]
    fn unix_shell_falls_back_to_standard_shells() {
        for env_shell in [None, Some(""), Some("/missing/shell")] {
            assert_eq!(
                select_login_shell(env_shell, |candidate| candidate == "/bin/bash"),
                "/bin/bash"
            );
        }
        assert_eq!(select_login_shell(None, |_| false), "/bin/sh");
    }
}
