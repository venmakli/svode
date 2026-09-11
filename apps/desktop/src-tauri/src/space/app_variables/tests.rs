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
    let config = path.parent().unwrap().join("library");
    crate::space::registry::add_space(
        &config,
        &ulid::Ulid::new().to_string(),
        path.to_str().unwrap(),
    )
    .unwrap();
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
    let operation = if catalog.entries.iter().any(|e| e.name == name) {
        svode_core::variables::SaveOperation::Edit
    } else {
        svode_core::variables::SaveOperation::Create
    };
    service
        .save(
            &owner,
            Save {
                name: name.into(),
                mode,
                kind,
                value: value.map(str::to_string),
                revision: catalog.revision,
                operation,
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
        SourceOwner::Global,
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
fn old_registry_is_rejected_and_context_read_does_not_materialize_variables() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("library");
    let root = dir.path().join("project");
    project(&root);
    let app = app(&root, false, &["KEY"]);
    let before = fs::read(root.join(".svode/config.json")).unwrap();
    let context = registry::prepare_context(&config, &app).unwrap();
    assert!(!context.owner_key.is_empty());
    assert!(!root.join(".svode/local.json").exists());
    assert!(!config.join("settings.json").exists());
    assert_eq!(fs::read(root.join(".svode/config.json")).unwrap(), before);
    let old = json!({"appVariableRegistry":{"bindings":{"version":1,"legacyNormalized":true,"owners":{}},"usage":{}}}).to_string();
    fs::write(config.join("settings.json"), &old).unwrap();
    assert!(registry::prepare_context(&config, &app).is_err());
    assert_eq!(
        fs::read_to_string(config.join("settings.json")).unwrap(),
        old
    );
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
        SourceOwner::Global,
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
        .find(|e| e.source.owner == SourceOwner::Global)
        .unwrap();
    let owner = Owner::global(&config).unwrap();
    let service = Service::new(&secrets);
    assert_eq!(entry.revision, service.catalog(&owner).unwrap().revision);
    let input = |revision: Revision| Save {
        name: "KEY".into(),
        mode: Mode::Local,
        kind: Kind::Variable,
        value: Some("after".into()),
        operation: core::SaveOperation::Edit,
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
        SourceOwner::Global,
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
            owner: SourceOwner::Global,
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
    let mut registration = crate::space::registry::read_registry(&config).unwrap();
    registration
        .spaces
        .iter_mut()
        .find(|s| Path::new(&s.path) == root)
        .unwrap()
        .path = moved.to_str().unwrap().into();
    crate::space::registry::write_registry(&config, &registration).unwrap();
    assert_eq!(
        run(&config, &app(&moved, false, &["KEY"]), &secrets).environment["KEY"],
        "synthetic"
    );
    project(&root);
    assert_eq!(
        run(&config, &app(&root, false, &["KEY"]), &secrets)
            .missing
            .len(),
        1
    );
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
    crate::space::registry::add_space(&config, "clone", clone.to_str().unwrap()).unwrap();
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
    local["variables"]["PUBLIC"] =
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

#[test]
fn source_picker_includes_library_without_polluting_scoped_settings_catalog() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("library");
    let root = dir.path().join("project");
    project(&root);
    let scope = app(&root, true, &[]).scope;
    let secrets = Secrets::default();
    for source in [
        SourceOwner::Project,
        SourceOwner::Space { id: "child".into() },
        SourceOwner::Global,
    ] {
        put(
            &config,
            Some(&scope),
            source,
            "KEY",
            Mode::Local,
            Kind::Secret,
            Some("df107-secret-value-must-not-appear"),
            &secrets,
        );
    }
    put(
        &config,
        None,
        SourceOwner::Global,
        "DADATA_API_KEY",
        Mode::Local,
        Kind::Secret,
        Some("df107-secret-value-must-not-appear"),
        &secrets,
    );
    for child in [true, false] {
        let scope = VariableScope {
            space_id: child.then(|| "child".into()),
            ..scope.clone()
        };
        let catalog = get_source_catalog(&config, Some(&scope), &secrets).unwrap();
        assert_eq!(catalog.default_owner, scope.owner());
        assert_eq!(catalog.entries.len(), if child { 4 } else { 3 });
        let library = catalog
            .entries
            .iter()
            .find(|e| e.entry.name == "DADATA_API_KEY")
            .unwrap();
        assert_eq!(library.source.owner, SourceOwner::Global);
        assert!(library.entry.has_value && library.entry.value.is_none());
        assert!(
            !serde_json::to_string(&catalog)
                .unwrap()
                .contains("df107-secret-value-must-not-appear")
        );
        let settings = get_catalog(&config, Some(&scope), None, &secrets).unwrap();
        assert!(
            settings
                .entries
                .iter()
                .all(|e| e.source.owner != SourceOwner::Global)
        );
    }
    let library = get_source_catalog(&config, None, &secrets).unwrap();
    assert_eq!(library.owners.len(), 1);
    assert_eq!(library.entries.len(), 2);
}

#[test]
fn app_owner_keys_follow_registered_child_path_and_distinguish_root() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("library");
    let root = dir.path().join("project");
    project(&root);
    let root_app = app(&root, false, &["KEY"]);
    let child_app = app(&root, true, &["KEY"]);
    let root_key = registry::prepare_context(&config, &root_app)
        .unwrap()
        .owner_key;
    let child_key = registry::prepare_context(&config, &child_app)
        .unwrap()
        .owner_key;
    assert_ne!(root_key, child_key);
    fs::rename(root.join("child"), root.join("renamed-space")).unwrap();
    let path = root.join(".svode/config.json");
    let mut value = core::files::read(&path, true).unwrap();
    value["spaces"][0]["path"] = json!("renamed-space");
    core::files::atomic_write(&path, &value).unwrap();
    let moved = AppVariableOwnerContext {
        owner_directory: root.join("renamed-space/app").to_str().unwrap().into(),
        ..child_app
    };
    assert_eq!(
        registry::prepare_context(&config, &moved)
            .unwrap()
            .owner_key,
        child_key
    );
    assert!(!root.join(".svode/local.json").exists());
    assert!(!root.join("renamed-space/.svode/local.json").exists());
    assert!(!config.join("settings.json").exists());
}
