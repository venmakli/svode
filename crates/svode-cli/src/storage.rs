//! `svode storage`: file storage of the selected Space on this device
//! without the desktop app, through `svode_core::storage`. The commands
//! exist only in the CLI: no catalog tool serves them. Secrets are named;
//! their values never appear in output, errors or logs.

use std::path::Path;

use serde_json::{Map, Value, json};
use svode_core::storage::connection::{self, ConnectError, ConnectRequest, LfsNotReady};
use svode_core::storage::lfs::LfsState;
use svode_core::storage::s3::SecretBindings;
use svode_core::storage::scope::{AssetsScope, AssetsScopeError, resolve_assets_scope};
use svode_core::variables::{SourceOwner, SourceReference, valid_name};
use svode_tools::error::ToolError;
use svode_tools::host::ToolHost;

use crate::error::CliError;
use crate::grammar::{S3ConnectArgs, SecretOwner, StorageS3Verb, StorageVerb};
use crate::output::Outcome;
use crate::target::{Selectors, Target};
use crate::tools::envelope;

/// General failure of an operation without a code of its own.
const SVODE_ERROR: &str = "SVODE_ERROR";
/// A Variables failure without a Secret code of its own.
const VARIABLES_ERROR: &str = "VARIABLES_ERROR";

pub async fn run(
    host: &impl ToolHost,
    verb: StorageVerb,
    selectors: &Selectors<'_>,
) -> Result<Outcome, CliError> {
    let target = selectors.resolve()?;
    target.open(host).await?;
    let scope = scope(host, &target).await?;
    match verb {
        StorageVerb::Status => Ok(status(host, &target, &scope).await),
        StorageVerb::S3 {
            verb: StorageS3Verb::Connect(args),
        } => connect(host, &target, &scope, args).await,
    }
}

/// Effective storage scope of the selected Space, by the inheritance rule
/// of the desktop app.
async fn scope(host: &impl ToolHost, target: &Target) -> Result<AssetsScope, CliError> {
    resolve_assets_scope(
        host.read_runtime().index,
        &target.space.project_path,
        target.space.space_id.as_deref(),
    )
    .await
    .map_err(|error| {
        let error = match error {
            AssetsScopeError::Index(error) => ToolError::from(error),
            AssetsScopeError::Config(error) => {
                ToolError::new(SVODE_ERROR, format!("Storage: {error}"))
            }
        };
        CliError::operation(error.code, error.message).with_target(target.envelope())
    })
}

/// The scope fields of the result.
fn scope_json(target: &Target, scope: &AssetsScope) -> Value {
    json!({
        "repository": shown(&target.space.project_path, &scope.repo_dir),
        "inheritedFromProject": scope.inherited_from_project,
    })
}

/// `path` relative to the Project when it lies inside it, else absolute.
fn shown(project: &Path, path: &Path) -> String {
    match path.strip_prefix(project) {
        Ok(relative) if relative.as_os_str().is_empty() => ".".to_string(),
        Ok(relative) => relative.display().to_string(),
        Err(_) => path.display().to_string(),
    }
}

fn owner_label(owner: &SourceOwner) -> &'static str {
    match owner {
        SourceOwner::Global => "device",
        SourceOwner::Project => "project",
        SourceOwner::Space { .. } => "space",
    }
}

fn bindings_json(bindings: &SecretBindings) -> Value {
    let role = |reference: &SourceReference| json!({ "name": reference.name, "owner": owner_label(&reference.owner) });
    json!({
        "accessKey": role(&bindings.access_key),
        "secretKey": role(&bindings.secret_key),
    })
}

fn problem_json(problem: &LfsNotReady) -> Value {
    json!({
        "code": problem.code(),
        "message": problem.to_string(),
        "hint": problem.hint(),
    })
}

async fn status(host: &impl ToolHost, target: &Target, scope: &AssetsScope) -> Outcome {
    let status = connection::status(host.read_runtime().git, &scope.repo_dir, &scope.config).await;
    let lfs = serde_json::to_value(status.lfs).unwrap_or_default();
    let mut human = format!("strategy: {}", status.strategy.as_str());
    if scope.inherited_from_project {
        human.push_str(" (from the Project)");
    }
    human.push('\n');
    if let Some(s3) = &status.s3 {
        human.push_str(&format!(
            "s3: {} bucket {} region {} prefix {}\n",
            s3.endpoint, s3.bucket, s3.region, s3.prefix
        ));
    }
    if let Some(bindings) = &status.bindings {
        human.push_str(&format!(
            "secrets: access key {} ({}), secret key {} ({})\n",
            bindings.access_key.name,
            owner_label(&bindings.access_key.owner),
            bindings.secret_key.name,
            owner_label(&bindings.secret_key.owner),
        ));
    }
    match (&status.problem, status.lfs) {
        (None, LfsState::NotApplicable) => human.push_str("git lfs: not used\n"),
        (None, _) => human.push_str("git lfs: ready\n"),
        (Some(problem), _) => {
            human.push_str(&format!(
                "git lfs: not ready — {}{}\n",
                problem
                    .code()
                    .map(|code| format!("{code}: "))
                    .unwrap_or_default(),
                problem
            ));
            if let Some(hint) = problem.hint() {
                human.push_str(&format!("next step: {hint}\n"));
            }
        }
    }
    let mut storage = scope_json(target, scope);
    storage["strategy"] = json!(status.strategy.as_str());
    storage["s3"] = status.s3.as_ref().map_or(Value::Null, |s3| {
        json!({
            "endpoint": s3.endpoint,
            "bucket": s3.bucket,
            "region": s3.region,
            "prefix": s3.prefix,
        })
    });
    storage["bindings"] = status.bindings.as_ref().map_or(Value::Null, bindings_json);
    storage["lfs"] = lfs;
    storage["ready"] = json!(status.problem.is_none());
    storage["problem"] = status.problem.as_ref().map_or(Value::Null, problem_json);
    storage["nextStep"] = json!(status.problem.as_ref().and_then(LfsNotReady::hint));
    Outcome {
        human,
        envelope: envelope(target.envelope(), json!({ "storage": storage })),
        warnings: Vec::new(),
    }
}

fn checked_name(name: &str) -> Result<(), CliError> {
    if valid_name(name) {
        Ok(())
    } else {
        Err(CliError::argument(format!(
            "{name}: {}",
            svode_core::variables::Error::InvalidName
        )))
    }
}

/// Refusal of a storage that is not ready, with its code and next step.
fn not_ready(reason: &LfsNotReady, target: Map<String, Value>) -> CliError {
    let code = reason.code().unwrap_or(match reason {
        LfsNotReady::Secret(_) => VARIABLES_ERROR,
        _ => SVODE_ERROR,
    });
    let mut refusal = CliError::operation(code, reason.to_string()).with_target(target);
    if let LfsNotReady::Secret(failure) = reason
        && code == VARIABLES_ERROR
    {
        refusal.evidence.insert(
            "reason".into(),
            serde_json::to_value(&failure.error).unwrap_or_default(),
        );
    }
    if let Some(hint) = reason.hint() {
        refusal.evidence.insert("hint".into(), json!(hint));
    }
    refusal
}

async fn connect(
    host: &impl ToolHost,
    target: &Target,
    scope: &AssetsScope,
    args: S3ConnectArgs,
) -> Result<Outcome, CliError> {
    checked_name(&args.access_key)?;
    checked_name(&args.secret_key)?;
    let known = target.envelope();
    let catalog = crate::secret::config_dir()?;
    host.require_mutation_access(&scope.repo_dir)
        .await
        .map_err(|error| {
            let mut failure =
                CliError::operation(error.code, error.message).with_target(known.clone());
            failure.evidence = error.evidence;
            failure
        })?;
    // An inline Space uses the storage of the Project, so its Secrets are
    // resolved in the context of the Project, as the root Space is.
    let space_id = if scope.inherited_from_project {
        None
    } else {
        target.space.space_id.clone()
    };
    let owner = match (args.owner.owner, &space_id) {
        (SecretOwner::Device, _) => SourceOwner::Global,
        (SecretOwner::Space, Some(id)) => SourceOwner::Space { id: id.clone() },
        (SecretOwner::Project | SecretOwner::Space, _) => SourceOwner::Project,
    };
    let reference = |name: String| SourceReference {
        owner: owner.clone(),
        name,
    };
    let bindings = SecretBindings {
        access_key: reference(args.access_key),
        secret_key: reference(args.secret_key),
    };
    let project = &target.space.project_path;
    let connected = connection::connect(
        host.read_runtime().git,
        ConnectRequest {
            catalog_dir: &catalog,
            project_path: project,
            space_id: space_id.as_deref(),
            repo_dir: &scope.repo_dir,
            config: &scope.config,
            bindings,
        },
    )
    .await
    .map_err(|error| match error {
        ConnectError::NotReady(reason) => not_ready(&reason, known.clone()),
        ConnectError::Git(error) => {
            let error = ToolError::from(error);
            CliError::operation(error.code, error.message).with_target(known.clone())
        }
        ConnectError::Storage(message) => {
            CliError::operation(SVODE_ERROR, format!("Storage: {message}"))
                .with_target(known.clone())
        }
    })?;
    let changed = connected
        .changed
        .iter()
        .map(|path| shown(project, path))
        .collect::<Vec<_>>();
    let agent = &connected.config;
    let mut human = format!(
        "This device is connected to the S3 storage {}/{} at {}.\n",
        agent.bucket,
        agent.prefix.as_deref().unwrap_or_default(),
        agent.endpoint
    );
    if changed.is_empty() {
        human.push_str("It was already connected with these Secrets; no file changed.\n");
    } else {
        human.push_str("Changed files (nothing is committed):\n");
        for path in &changed {
            human.push_str(&format!("  {path}\n"));
        }
    }
    let mut storage = scope_json(target, scope);
    storage["strategy"] = json!(scope.config.strategy.as_str());
    storage["s3"] = json!({
        "endpoint": agent.endpoint,
        "bucket": agent.bucket,
        "region": agent.region,
        "prefix": agent.prefix,
    });
    storage["bindings"] = bindings_json(&agent.bindings);
    storage["lfs"] = json!(LfsState::Ready);
    Ok(Outcome {
        human,
        envelope: envelope(
            known,
            json!({
                "storage": storage,
                "changedPaths": changed,
                "committed": false,
            }),
        ),
        warnings: Vec::new(),
    })
}
