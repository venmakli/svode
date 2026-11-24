use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::json;
use svode_agents::registry::AdapterRuntimeRegistry;
use svode_agents::writer::ExternalLiveness;
use svode_agents::{AcpLaunch, AgentRuntime, ExistingSessionDirectory, LaunchEnvironment};
use svode_core::agent_adapters::AgentAdapterKind;

struct History {
    id: String,
    cwd: PathBuf,
    answer: String,
}

fn seed(store: &Path, cwd: &Path, id: u32, answer: &str) -> History {
    let cwd_text = cwd.to_str().unwrap();
    let key = if cfg!(windows) {
        cwd_text.to_lowercase()
    } else {
        cwd_text.to_owned()
    };
    let key: String = key
        .encode_utf16()
        .map(|unit| match u8::try_from(unit) {
            Ok(byte) if byte.is_ascii_alphanumeric() => char::from(byte),
            _ => '-',
        })
        .collect();
    let dir = store.join("projects").join(key).join("chats");
    fs::create_dir_all(&dir).unwrap();
    let id = format!("00000000-0000-4000-8000-{id:012}");
    let user = "10000000-0000-4000-8000-000000000001";
    let timestamp = "2026-11-24T10:00:00.000Z";
    let first = json!({
        "uuid": user, "parentUuid": null, "sessionId": id, "timestamp": timestamp,
        "type": "user", "cwd": cwd, "version": "0.24.7",
        "message": {"role": "user", "parts": [{"text": "Prepared question"}]},
    });
    let second = json!({
        "uuid": "10000000-0000-4000-8000-000000000002", "parentUuid": user,
        "sessionId": id, "timestamp": timestamp, "type": "assistant", "cwd": cwd,
        "version": "0.24.7", "message": {"role": "model", "parts": [{"text": answer}]},
    });
    fs::write(
        dir.join(format!("{id}.jsonl")),
        format!("{first}\n{second}\n"),
    )
    .unwrap();
    History {
        id,
        cwd: cwd.to_owned(),
        answer: answer.to_owned(),
    }
}

fn launch(project: &Path, profile: &Path, store: &Path) -> AcpLaunch {
    let (program, mut args) = if let Some(entry) = std::env::var_os("SVODE_QWEN_TEST_NODE_ENTRY") {
        (
            PathBuf::from("node"),
            vec![entry.into_string().expect("Unicode Node entrypoint")],
        )
    } else {
        (
            PathBuf::from(
                std::env::var_os("SVODE_QWEN_TEST_BINARY").expect("pinned Qwen CLI path"),
            ),
            Vec::new(),
        )
    };
    args.extend(["--acp".into(), "--auth-type=openai".into()]);
    // Keep the OS process environment and leave the user's agent credentials out.
    let environment = LaunchEnvironment::new(
        [
            "PATH",
            "HOME",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "SystemRoot",
            "WINDIR",
            "COMSPEC",
            "TEMP",
            "TMP",
            "TMPDIR",
        ]
        .into_iter()
        .filter_map(|name| {
            std::env::var_os(name).map(|value| (OsStr::new(name).to_owned(), value))
        }),
    );
    AcpLaunch {
        agent: AgentAdapterKind::QwenCode.as_str().into(),
        program,
        args,
        environment: Some(environment),
        env: BTreeMap::from([
            (
                "QWEN_HOME".into(),
                svode_core::system_path::user_facing_path(profile),
            ),
            (
                "QWEN_RUNTIME_DIR".into(),
                svode_core::system_path::user_facing_path(store),
            ),
            ("OPENAI_API_KEY".into(), "fixture".into()),
            ("OPENAI_BASE_URL".into(), "http://127.0.0.1:1".into()),
            ("OPENAI_MODEL".into(), "fixture".into()),
        ]),
        cwd: PathBuf::from(svode_core::system_path::user_facing_path(project)),
        acp_id_is_native: true,
        lists_catalog: true,
        read_only_open: true,
        reads_during_external_turn: true,
        writer_refusal: None,
        session_per_connection: false,
        keeps_loaded_sessions: false,
        draft_session: Default::default(),
    }
}

#[tokio::test]
#[ignore = "requires the pinned Qwen Code 0.24.7 CLI"]
async fn real_qwen_catalog_replays_both_folder_spellings_after_restart() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let project = root.join("Fixture Пример");
    let child = project.join("Child Space");
    let profile = root.join("profile");
    let store = root.join("runtime");
    fs::create_dir_all(&child).unwrap();
    fs::create_dir(&profile).unwrap();
    fs::write(
        profile.join("settings.json"),
        json!({
            "security": {"auth": {"selectedType": "openai"}},
            "telemetry": {"enabled": false},
            "general": {"enableAutoUpdate": false, "enableAutoUpdateNotification": false},
        })
        .to_string(),
    )
    .unwrap();

    let mut fixtures = Vec::new();
    for (fd, first_id) in [(&project, 1), (&child, 4)] {
        let ordinary = PathBuf::from(svode_core::system_path::user_facing_path(fd));
        let mut expected = vec![seed(&store, &ordinary, first_id, "Ordinary history")];
        if cfg!(windows) {
            assert_ne!(&ordinary, fd);
            expected.push(seed(&store, fd, first_id + 1, "Legacy history"));
            seed(&store, fd, first_id + 2, "Duplicate legacy history");
            expected.push(seed(
                &store,
                &ordinary,
                first_id + 2,
                "Preferred ordinary history",
            ));
        }
        fixtures.push((fd, expected));
    }

    let launch = launch(&project, &profile, &store);
    for _ in 0..2 {
        let runtime = AgentRuntime::default();
        let list_connection = runtime.connect(launch.clone()).await.unwrap();
        let agent = runtime
            .connection_status(list_connection)
            .unwrap()
            .agent
            .unwrap();
        assert_eq!(agent.version.as_deref(), Some("0.24.7"));
        println!("Qwen Code {}", agent.version.unwrap());
        for (folder, expected) in &fixtures {
            let list = runtime
                .list_folder_sessions(list_connection, folder)
                .await
                .unwrap();
            assert!(!list.truncated);
            assert_eq!(list.sessions.len(), expected.len());
            for history in expected {
                let session = list
                    .sessions
                    .iter()
                    .find(|session| session.key.session_id == history.id)
                    .unwrap();
                assert_eq!(session.cwd, history.cwd);
                let cwd = AdapterRuntimeRegistry.qwen_session_cwd(folder, Some(&session.cwd));
                let directory = ExistingSessionDirectory::qwen(folder, &cwd);
                let connection = runtime.connect(launch.clone()).await.unwrap();
                runtime
                    .read_session(
                        connection,
                        &session.key,
                        directory,
                        ExternalLiveness::Free,
                        false,
                    )
                    .await
                    .unwrap();
                let snapshot = runtime.watch(&session.key).unwrap().snapshot;
                let replayed = snapshot.items.iter().any(|item| {
                    serde_json::to_string(&runtime.detail(&session.key, &item.id))
                        .unwrap()
                        .contains(&history.answer)
                });
                assert!(
                    replayed,
                    "missing history {:?} for {}",
                    history.answer, history.id
                );
                runtime.close_connection(connection).await.unwrap();
            }
        }
        runtime.close_connection(list_connection).await.unwrap();
    }
}
