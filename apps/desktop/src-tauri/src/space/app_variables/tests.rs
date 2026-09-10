use super::*;
use serde_json::json;
use std::{fs, sync::Mutex};
use svode_core::variables::{Kind, Mode, Revision, Save};

#[derive(Default)]
struct Secrets(Mutex<BTreeMap<String, String>>);
impl SecretStore for Secrets {
    fn get(&self, name: &str) -> core::Result<Option<String>> {
        Ok(self.0.lock().unwrap().get(name).cloned())
    }
    fn set(&self, name: &str, value: &str) -> core::Result<()> {
        self.0.lock().unwrap().insert(name.into(), value.into());
        Ok(())
    }
    fn remove(&self, name: &str) -> core::Result<()> {
        self.0.lock().unwrap().remove(name);
        Ok(())
    }
}
fn project(path: &Path) {
    fs::create_dir_all(path.join(".svode")).unwrap();
    fs::create_dir_all(path.join("child/.svode")).unwrap();
    fs::write(
        path.join(".svode/config.json"),
        json!({"name":"Test", "spaces":[{"id":"child","path":"child"}]}).to_string(),
    )
    .unwrap();
    fs::write(path.join("child/.svode/config.json"), "{}").unwrap();
}
fn app(path: &Path, child: bool, refs: &[&str]) -> AppVariableOwnerContext {
    let path = path.canonicalize().unwrap();
    let directory = path.join(if child { "child/app" } else { "app" });
    fs::create_dir_all(&directory).unwrap();
    AppVariableOwnerContext {
        scope: VariableScope {
            project_path: path.to_str().unwrap().into(),
            space_id: child.then(|| "child".into()),
        },
        owner_key: directory.to_str().unwrap().into(),
        owner_directory: directory.to_str().unwrap().into(),
        references: refs.iter().map(|s| s.to_string()).collect(),
    }
}
fn put(
    config: &Path,
    scope: Option<&VariableScope>,
    source: SourceOwner,
    name: &str,
    mode: Mode,
    kind: Kind,
    value: Option<&str>,
    secrets: &Secrets,
) {
    let owner = owner(config, scope, &source).unwrap();
    let service = Service::new(secrets);
    let catalog = service.catalog(&owner).unwrap();
    let identity = catalog
        .entries
        .iter()
        .find(|e| e.name == name)
        .map(|e| e.identity.clone());
    service
        .save(
            &owner,
            Save {
                name: name.into(),
                mode,
                kind,
                value: value.map(str::to_string),
                revision: catalog.revision,
                identity,
                keep: None,
            },
        )
        .unwrap();
}
fn run(
    config: &Path,
    context: &AppVariableOwnerContext,
    secrets: &Secrets,
) -> ResolvedAppEnvironment {
    let declaration = context
        .references
        .iter()
        .map(|n| (n.clone(), format!("${{{n}}}")))
        .collect();
    resolve_environment(config, context, &declaration, secrets).unwrap()
}
#[test]
fn scoped_apps_isolate_projects_and_stop_at_missing_nearest_declaration() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("library");
    let a = dir.path().join("a");
    let b = dir.path().join("b");
    project(&a);
    project(&b);
    let root = app(&a, false, &["KEY"]);
    let child = app(&a, true, &["KEY"]);
    let other = app(&b, false, &["KEY"]);
    let secrets = Secrets::default();
    put(
        &config,
        None,
        SourceOwner::Library,
        "KEY",
        Mode::Local,
        Kind::Variable,
        Some("library"),
        &secrets,
    );
    assert_eq!(run(&config, &root, &secrets).missing.len(), 1);
    put(
        &config,
        Some(&root.scope),
        SourceOwner::Project,
        "KEY",
        Mode::Git,
        Kind::Variable,
        Some("project"),
        &secrets,
    );
    assert_eq!(run(&config, &child, &secrets).environment["KEY"], "project");
    assert_eq!(run(&config, &other, &secrets).missing.len(), 1);
    put(
        &config,
        Some(&child.scope),
        child.scope.owner(),
        "KEY",
        Mode::Git,
        Kind::Secret,
        None,
        &secrets,
    );
    assert_eq!(run(&config, &child, &secrets).missing.len(), 1);
    let catalog = get_catalog(&config, Some(&child.scope), Some(&child), &secrets).unwrap();
    assert!(!catalog.context.as_ref().unwrap()[0].resolved);
    bind(
        &config,
        &child,
        "KEY",
        Some(SourceReference {
            owner: SourceOwner::Project,
            name: "KEY".into(),
        }),
        &catalog.binding_revision,
        &secrets,
    )
    .unwrap();
    assert_eq!(run(&config, &child, &secrets).environment["KEY"], "project");
}
#[test]
fn legacy_snapshot_is_normalized_before_new_usage_and_removed_binding_stays_removed() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("library");
    let root = dir.path().join("project");
    project(&root);
    fs::create_dir_all(&config).unwrap();
    let old = app(&root, false, &["KEY", "MISSING"]);
    let secrets = Secrets::default();
    fs::write(config.join("settings.json"), json!({"variables":{"entries":{"KEY":{"kind":"variable","value":"legacy"}},"apps":{old.owner_key.clone():{"ownerDirectory":old.owner_key,"references":["KEY", "MISSING"]},"/unavailable/app":{"ownerDirectory":"/unavailable/app","references":["KEY"]}}}}).to_string()).unwrap();
    put(
        &config,
        Some(&old.scope),
        SourceOwner::Project,
        "KEY",
        Mode::Local,
        Kind::Variable,
        Some("scoped"),
        &secrets,
    );
    assert_eq!(run(&config, &old, &secrets).missing.len(), 1);
    let catalog = get_catalog(&config, Some(&old.scope), Some(&old), &secrets).unwrap();
    assert_eq!(
        catalog.context.as_ref().unwrap()[0].source.owner,
        SourceOwner::Library
    );
    assert!(
        registry::read(&config)
            .unwrap()
            .bindings
            .owners
            .contains_key("/unavailable/app")
    );
    bind(
        &config,
        &old,
        "KEY",
        None,
        &catalog.binding_revision,
        &secrets,
    )
    .unwrap();
    let single = AppVariableOwnerContext {
        references: vec!["KEY".into()],
        ..old.clone()
    };
    assert_eq!(run(&config, &single, &secrets).environment["KEY"], "scoped");
    assert_eq!(run(&config, &single, &secrets).environment["KEY"], "scoped");
    let clone = dir.path().join("clone");
    project(&clone);
    assert_eq!(
        run(&config, &app(&clone, false, &["KEY"]), &secrets)
            .missing
            .len(),
        1
    );
    assert!(!config.join("unavailable").exists());
}
#[test]
fn catalog_revision_survives_usage_projection_and_stale_edit_does_not_overwrite() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("library");
    let root = dir.path().join("project");
    project(&root);
    let app = app(&root, false, &["KEY"]);
    let secrets = Secrets::default();
    put(
        &config,
        None,
        SourceOwner::Library,
        "KEY",
        Mode::Local,
        Kind::Variable,
        Some("before"),
        &secrets,
    );
    let catalog = get_catalog(&config, Some(&app.scope), Some(&app), &secrets).unwrap();
    let entry = catalog
        .entries
        .iter()
        .find(|e| e.source.owner == SourceOwner::Library)
        .unwrap();
    let owner = Owner::library(&config).unwrap();
    let service = Service::new(&secrets);
    assert_eq!(entry.revision, service.catalog(&owner).unwrap().revision);
    let input = |revision: Revision| Save {
        name: "KEY".into(),
        mode: Mode::Local,
        kind: Kind::Variable,
        value: Some("after".into()),
        identity: Some(entry.entry.identity.clone()),
        revision,
        keep: None,
    };
    service.save(&owner, input(entry.revision.clone())).unwrap();
    assert_eq!(
        service
            .save(&owner, input(entry.revision.clone()))
            .unwrap_err(),
        core::Error::StaleRevision
    );
}
#[test]
fn missing_environment_is_never_partial_and_only_declared_values_are_expanded() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("library");
    let root = dir.path().join("project");
    project(&root);
    let app = app(&root, false, &["KEY", "OTHER"]);
    let secrets = Secrets::default();
    put(
        &config,
        Some(&app.scope),
        SourceOwner::Project,
        "KEY",
        Mode::Git,
        Kind::Variable,
        Some("${OTHER}"),
        &secrets,
    );
    assert!(run(&config, &app, &secrets).environment.is_empty());
    put(
        &config,
        Some(&app.scope),
        SourceOwner::Project,
        "OTHER",
        Mode::Local,
        Kind::Variable,
        Some(""),
        &secrets,
    );
    let declaration = BTreeMap::from([("VALUE".into(), "prefix-${KEY}-$${OTHER}".into())]);
    let context = AppVariableOwnerContext {
        references: vec!["KEY".into()],
        ..app
    };
    let resolved = resolve_environment(&config, &context, &declaration, &secrets).unwrap();
    assert_eq!(resolved.environment["VALUE"], "prefix-${OTHER}-${OTHER}");
}

#[test]
fn local_bindings_follow_scope_move_but_never_a_replacement_clone_at_the_same_path() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("library");
    let root = dir.path().join("project");
    project(&root);
    let original = app(&root, false, &["KEY"]);
    let secrets = Secrets::default();
    put(
        &config,
        None,
        SourceOwner::Library,
        "KEY",
        Mode::Local,
        Kind::Secret,
        Some("synthetic"),
        &secrets,
    );
    let catalog = get_catalog(&config, Some(&original.scope), Some(&original), &secrets).unwrap();
    bind(
        &config,
        &original,
        "KEY",
        Some(SourceReference {
            owner: SourceOwner::Library,
            name: "KEY".into(),
        }),
        &catalog.binding_revision,
        &secrets,
    )
    .unwrap();
    assert_eq!(
        run(&config, &original, &secrets).environment["KEY"],
        "synthetic"
    );
    let moved = dir.path().join("renamed");
    fs::rename(&root, &moved).unwrap();
    assert_eq!(
        run(&config, &app(&moved, false, &["KEY"]), &secrets).environment["KEY"],
        "synthetic"
    );
    project(&root);
    assert_eq!(run(&config, &original, &secrets).missing.len(), 1);
    assert!(
        clear_owner_usage(
            &config,
            &moved.join("app").canonicalize().unwrap().to_string_lossy()
        )
        .unwrap()
    );
    assert_eq!(
        run(&config, &app(&moved, false, &["KEY"]), &secrets)
            .missing
            .len(),
        1
    );
}

#[test]
fn app_runtime_reads_git_clone_checkout_and_collision_without_global_fallback() {
    fn git(path: &Path, args: &[&str]) -> String {
        let result = std::process::Command::new("git")
            .args(args)
            .current_dir(path)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        String::from_utf8(result.stdout).unwrap()
    }
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("library");
    let root = dir.path().join("project");
    project(&root);
    git(&root, &["init", "-b", "main"]);
    fs::write(
        root.join(".gitignore"),
        "**/.svode/local.json\n**/.svode/variables.*\n",
    )
    .unwrap();
    let context = app(&root, false, &["PUBLIC", "KEY"]);
    let secrets = Secrets::default();
    put(
        &config,
        Some(&context.scope),
        SourceOwner::Project,
        "PUBLIC",
        Mode::Git,
        Kind::Variable,
        Some("v1"),
        &secrets,
    );
    put(
        &config,
        Some(&context.scope),
        SourceOwner::Project,
        "KEY",
        Mode::Git,
        Kind::Secret,
        Some("synthetic"),
        &secrets,
    );
    git(&root, &["add", "."]);
    assert!(!git(&root, &["diff", "--cached"]).contains("synthetic"));
    assert!(!git(&root, &["ls-files"]).contains("local.json"));
    git(
        &root,
        &[
            "-c",
            "user.name=Synthetic",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            "Variables",
        ],
    );
    let clone = dir.path().join("clone");
    git(
        dir.path(),
        &["clone", root.to_str().unwrap(), clone.to_str().unwrap()],
    );
    let cloned = app(&clone, false, &["PUBLIC", "KEY"]);
    assert_eq!(
        run(&config, &cloned, &secrets).missing[0].reference_name,
        "KEY"
    );
    let single = AppVariableOwnerContext {
        references: vec!["PUBLIC".into()],
        ..cloned
    };
    assert_eq!(run(&config, &single, &secrets).environment["PUBLIC"], "v1");
    put(
        &config,
        Some(&context.scope),
        SourceOwner::Project,
        "PUBLIC",
        Mode::Git,
        Kind::Variable,
        Some("v2"),
        &secrets,
    );
    git(&root, &["add", ".svode/config.json"]);
    git(
        &root,
        &[
            "-c",
            "user.name=Synthetic",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            "Rotate",
        ],
    );
    git(&clone, &["pull", "--ff-only"]);
    assert_eq!(run(&config, &single, &secrets).environment["PUBLIC"], "v2");
    git(&clone, &["checkout", "HEAD~1", "--", ".svode/config.json"]);
    assert_eq!(run(&config, &single, &secrets).environment["PUBLIC"], "v1");
    let path = clone.join(".svode/local.json");
    let mut local = core::files::read(&path, false).unwrap();
    local["variables"]["entries"]["PUBLIC"] =
        json!({"id":ulid::Ulid::new().to_string(), "kind":"variable", "value":"conflict"});
    core::files::atomic_write(&path, &local).unwrap();
    assert!(run(&config, &single, &secrets).environment.is_empty());
    assert_eq!(run(&config, &single, &secrets).missing.len(), 1);
}

#[test]
fn catalog_includes_current_shared_usage_and_removes_stale_references() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("library");
    let root = dir.path().join("project");
    project(&root);
    let app = app(&root, false, &["KEY", "ALIAS"]);
    let secrets = Secrets::default();
    put(
        &config,
        Some(&app.scope),
        SourceOwner::Project,
        "KEY",
        Mode::Local,
        Kind::Variable,
        Some("value"),
        &secrets,
    );
    bind(
        &config,
        &app,
        "ALIAS",
        Some(SourceReference {
            owner: SourceOwner::Project,
            name: "KEY".into(),
        }),
        &registry::revision(&registry::read(&config).unwrap()),
        &secrets,
    )
    .unwrap();
    let catalog = get_catalog(&config, Some(&app.scope), Some(&app), &secrets).unwrap();
    assert_eq!(catalog.entries[0].used_in.len(), 2);
    assert!(
        catalog.entries[0]
            .used_in
            .iter()
            .all(|u| u.owner_directory == app.owner_directory)
    );
    let reduced = AppVariableOwnerContext {
        references: vec!["KEY".into()],
        ..app
    };
    let catalog = get_catalog(&config, Some(&reduced.scope), Some(&reduced), &secrets).unwrap();
    assert_eq!(catalog.entries[0].used_in.len(), 1);
    assert_eq!(catalog.entries[0].used_in[0].reference_name, "KEY");
}
