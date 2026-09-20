use super::{
    BTreeMap, GitCli, GitError, GitOutput, Path, PublicationBlockReason, blocked, checked,
    sensitive,
};

#[derive(Debug, PartialEq, Eq)]
struct LocalFacts {
    branch: String,
    refs: String,
    config: String,
    modules: Option<Vec<u8>>,
    ordinary_repository: bool,
    complete_repository: bool,
}

impl LocalFacts {
    async fn read(cli: &GitCli, repo: &Path) -> Result<Self, GitError> {
        let (branch, refs, config, paths) = tokio::join!(
            cli.exec_redacted(repo, &["symbolic-ref", "-q", "HEAD"]),
            checked(cli, repo, &["show-ref", "--head"]),
            checked(cli, repo, &["config", "--null", "--list"]),
            checked(
                cli,
                repo,
                &[
                    "rev-parse",
                    "--path-format=absolute",
                    "--git-common-dir",
                    "--is-shallow-repository"
                ]
            ),
        );
        let branch = branch?;
        if branch.exit_code > 1 {
            return Err(blocked(repo, None, PublicationBlockReason::Configuration));
        }
        let branch = branch.stdout.trim_end().to_owned();
        let (refs, config, paths) = (refs?, config?, paths?);
        let mut paths = paths.lines();
        let common = Path::new(
            paths
                .next()
                .ok_or_else(|| blocked(repo, None, PublicationBlockReason::Configuration))?,
        );
        let ordinary_repository =
            !common.join("remotes").exists() && !common.join("branches").exists();
        let promisor_pack = match std::fs::read_dir(common.join("objects/pack")) {
            Ok(entries) => entries.into_iter().any(|entry| {
                entry.map_or(true, |entry| {
                    entry
                        .path()
                        .extension()
                        .is_some_and(|ext| ext == "promisor")
                })
            }),
            Err(error) => error.kind() != std::io::ErrorKind::NotFound,
        };
        let complete_repository = paths.next() == Some("false")
            && !promisor_pack
            && !config.split('\0').any(|entry| {
                let key = entry.split_once('\n').map_or(entry, |(key, _)| key);
                key == "extensions.partialclone"
                    || key.ends_with(".promisor")
                    || key.ends_with(".partialclonefilter")
            });
        let modules = match std::fs::read(repo.join(".gitmodules")) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        Ok(Self {
            branch,
            refs,
            config,
            modules,
            ordinary_repository,
            complete_repository,
        })
    }

    fn values<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a str> {
        self.config.split('\0').filter_map(move |entry| {
            let (key, value) = entry.split_once('\n').unwrap_or((entry, ""));
            (key == name).then_some(value)
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Snapshot {
    pub(super) destination: String,
    pub(super) updates: BTreeMap<String, String>,
    pub(super) head: String,
    pub(super) remote: String,
    pub(super) remote_refs: String,
    local: LocalFacts,
    sources: BTreeMap<String, String>,
    mappings: BTreeMap<String, String>,
    fetch_urls: String,
}

impl Snapshot {
    fn reusable_mapping(&self) -> bool {
        if self.remote != "origin"
            || !self.local.ordinary_repository
            || self.mappings.len() != 1
            || self.mappings.get(&self.local.branch) != Some(&self.local.branch)
            || self.fetch_urls.lines().count() != 1
        {
            return false;
        }
        // Unknown/custom rules retain Git's second authoritative discovery.
        self.local.config.split('\0').all(|entry| {
            let (key, value) = entry.split_once('\n').unwrap_or((entry, ""));
            !(key.starts_with("remote.")
                && (key.ends_with(".push") || key.ends_with(".mirror") || key.ends_with(".vcs")))
                && !key.starts_with("url.")
                && !key.starts_with("remotes.")
                && (key != "push.default" || matches!(value, "simple" | "current"))
                && key != "push.followtags"
        }) && [&self.destination, &self.fetch_urls].iter().all(|url| {
            !url.contains("::")
                && url.split_once("://").is_none_or(|(scheme, _)| {
                    matches!(scheme, "file" | "ssh" | "git" | "http" | "https")
                })
        })
    }

    pub(super) fn complete_repository(&self) -> bool {
        self.local.complete_repository
    }

    pub(super) async fn revalidate(
        &self,
        cli: &GitCli,
        repo: &Path,
        first: bool,
    ) -> Result<(), GitError> {
        let unchanged = if self.reusable_mapping() {
            let changed = || blocked(repo, None, PublicationBlockReason::TargetChanged);
            let local = LocalFacts::read(cli, repo).await.map_err(|_| changed())?;
            if local != self.local {
                return Err(changed());
            }
            for (source, oid) in &self.sources {
                if checked(cli, repo, &["rev-parse", "--verify", source])
                    .await
                    .map_err(|_| changed())?
                    != *oid
                {
                    return Err(changed());
                }
            }
            let current = advertisement(cli, repo, &self.destination).await?;
            current.exit_code == 0 && sorted_refs(&current.stdout) == self.remote_refs
        } else {
            snapshot(cli, repo, first).await?.as_ref().ok() == Some(self)
        };
        if unchanged {
            Ok(())
        } else {
            Err(blocked(repo, None, PublicationBlockReason::TargetChanged))
        }
    }
}

fn sorted_refs(value: &str) -> String {
    let mut refs: Vec<_> = value.lines().collect();
    refs.sort_unstable();
    refs.join("\n")
}

async fn advertisement(
    cli: &GitCli,
    repo: &Path,
    destination: &str,
) -> Result<GitOutput, GitError> {
    sensitive(
        cli,
        repo,
        &[
            "ls-remote",
            "--refs",
            "--heads",
            "--tags",
            "--",
            destination,
        ],
    )
    .await
}

pub(super) async fn snapshot(
    cli: &GitCli,
    repo: &Path,
    first: bool,
) -> Result<Result<Snapshot, GitOutput>, GitError> {
    let local = LocalFacts::read(cli, repo).await?;
    let branch = local.branch.strip_prefix("refs/heads/").unwrap_or("HEAD");
    let mut args = vec![
        "push",
        "--dry-run",
        "--no-verify",
        "--porcelain",
        "--recurse-submodules=no",
    ];
    if first {
        args.extend(["origin", branch]);
    }
    let out = sensitive(cli, repo, &args).await?;
    if out.exit_code != 0 {
        return Ok(Err(out));
    }
    let head = local
        .refs
        .lines()
        .find_map(|line| line.strip_suffix(" HEAD"))
        .ok_or_else(|| blocked(repo, None, PublicationBlockReason::Configuration))?
        .to_owned();
    let mut destination = None;
    let mut updates = BTreeMap::new();
    let mut sources = BTreeMap::new();
    let mut mappings = BTreeMap::new();
    for line in out.stdout.lines() {
        if let Some(url) = line.strip_prefix("To ") {
            if destination.replace(url.to_owned()).is_some() {
                return Err(blocked(repo, None, PublicationBlockReason::Configuration));
            }
        } else if let Some((flag, rest)) = line.split_once('\t') {
            let mapping = rest.split('\t').next().unwrap_or_default();
            let (source, target) = mapping
                .split_once(':')
                .ok_or_else(|| blocked(repo, None, PublicationBlockReason::Configuration))?;
            if source.is_empty() || !target.starts_with("refs/") || flag == "+" || flag == "-" {
                return Err(blocked(repo, None, PublicationBlockReason::Configuration));
            }
            let oid = checked(cli, repo, &["rev-parse", "--verify", source]).await?;
            sources.insert(source.into(), oid.clone());
            mappings.insert(target.into(), source.into());
            if flag != "=" {
                updates.insert(target.into(), oid);
            }
        }
    }
    if !sources.values().any(|oid| oid == &head) {
        return Err(blocked(repo, None, PublicationBlockReason::Configuration));
    }
    let destination =
        destination.ok_or_else(|| blocked(repo, None, PublicationBlockReason::Configuration))?;
    let mut remote = "origin".to_owned();
    if !first {
        for key in [
            format!("branch.{branch}.remote"),
            "remote.pushdefault".into(),
            format!("branch.{branch}.pushremote"),
        ] {
            if let Some(value) = local.values(&key).last() {
                remote = value.to_owned();
            }
        }
    }
    let urls = sensitive(
        cli,
        repo,
        &["remote", "get-url", "--push", "--all", &remote],
    )
    .await?;
    if urls.exit_code != 0 || urls.stdout.lines().collect::<Vec<_>>() != [destination.as_str()] {
        return Err(blocked(repo, None, PublicationBlockReason::Configuration));
    }
    let fetch_urls = checked(cli, repo, &["remote", "get-url", "--all", &remote]).await?;
    let advertised = advertisement(cli, repo, &destination).await?;
    if advertised.exit_code != 0 {
        return Ok(Err(advertised));
    }
    Ok(Ok(Snapshot {
        destination,
        remote,
        remote_refs: sorted_refs(&advertised.stdout),
        updates,
        head,
        local,
        sources,
        mappings,
        fetch_urls,
    }))
}
