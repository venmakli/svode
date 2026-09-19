use std::path::Path;

use super::cli::GitCli;
use super::state::detected_cli;

pub(crate) use svode_core::page::dates::{EntryDateOverride, EntryDateOverrides};
use svode_core::page::dates::{GitDateExecutor, GitDateOutput};

impl GitDateExecutor for GitCli {
    async fn exec(&self, directory: &Path, args: &[&str]) -> Option<GitDateOutput> {
        let output = GitCli::exec(self, directory, args).await.ok()?;
        Some(GitDateOutput {
            stdout: output.stdout,
            exit_code: output.exit_code,
        })
    }
}

pub(crate) async fn derive_date_overrides(space: &Path, paths: &[String]) -> EntryDateOverrides {
    let Some(cli) = detected_cli() else {
        return EntryDateOverrides::new();
    };
    derive_date_overrides_with_cli(&cli, space, paths).await
}

pub(crate) async fn derive_date_overrides_with_cli(
    cli: &GitCli,
    space: &Path,
    paths: &[String],
) -> EntryDateOverrides {
    svode_core::page::dates::derive_date_overrides(cli, space, paths).await
}
