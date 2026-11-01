use std::path::Path;

use svode_core::git::cli::GitCli;
pub(crate) use svode_core::git::state::detected_cli;
use svode_core::page::dates::PageDateOverrides;

pub(crate) async fn derive_date_overrides(space: &Path, paths: &[String]) -> PageDateOverrides {
    let Some(cli) = detected_cli() else {
        return PageDateOverrides::new();
    };
    derive_date_overrides_with_cli(&cli, space, paths).await
}

pub(crate) async fn derive_date_overrides_with_cli(
    cli: &GitCli,
    space: &Path,
    paths: &[String],
) -> PageDateOverrides {
    svode_core::page::dates::derive_date_overrides(cli, space, paths).await
}
