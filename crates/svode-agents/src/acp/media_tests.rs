use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;

use serde_json::{Value, json};

use super::*;
use crate::acp::normalize::{self, Normalized};
use crate::activity::{
    ActivityItem, ConnectionState, DetailOutcome, FileChange, HistorySource, HistoryState,
    ItemKind, McpCallRef, MediaOutcome, MediaSegment, SessionSnapshot, ToolLocation,
    UnavailableReason, WriterState,
};
use crate::identity::SessionKey;
use crate::projection::Projection;
use crate::runtime::Retention;
use crate::status::StopReason;

/// Base64 of `pixel.png` as every agent sent it in E06 (placeholder sha).
const PIXEL: (usize, &str) = (16960, "09ae6884cc");

/// Deterministic base64 standing in for the data an E06 log abbreviated as
/// `<b64 len=N sha=X>`: the same placeholder is the same data.
fn data(len: usize, sha: &str) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut data = sha.to_string();
    data.extend(
        ALPHABET
            .iter()
            .cycle()
            .take(len.saturating_sub(sha.len()))
            .map(|byte| *byte as char),
    );
    data
}

fn expand_placeholders(line: &str) -> String {
    let mut expanded = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(start) = rest.find("<b64 len=") {
        let end = start + rest[start..].find('>').unwrap();
        let (len, sha) = rest[start + "<b64 len=".len()..end]
            .split_once(" sha=")
            .unwrap();
        expanded.push_str(&rest[..start]);
        expanded.push_str(&data(len.parse().unwrap(), sha));
        rest = &rest[end + 1..];
    }
    expanded.push_str(rest);
    expanded
}

/// An E06 log with its project folder and Kimi's session store moved into a
/// temporary directory, where `pixel.png` exists.
struct Fixture {
    dir: tempfile::TempDir,
    lines: Vec<(String, Value)>,
}

impl Fixture {
    fn load(name: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("svode-e06")).unwrap();
        std::fs::write(dir.path().join("svode-e06/pixel.png"), b"\x89PNG").unwrap();
        // A Svode project, so the paths of its Svode MCP calls resolve.
        std::fs::create_dir_all(dir.path().join("svode-e06/.svode")).unwrap();
        std::fs::write(dir.path().join("svode-e06/.svode/config.json"), "{}").unwrap();
        let project = dir.path().join("svode-e06");
        let scratch = dir.path().join("scratch");
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/e06")
            .join(format!("{name}.jsonl"));
        let lines = std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| {
                let line = expand_placeholders(line)
                    .replace("/Users/user/Documents/svode-e06", project.to_str().unwrap())
                    .replace("<scratch>", scratch.to_str().unwrap());
                let entry: Value = serde_json::from_str(&line).unwrap();
                (
                    entry["phase"].as_str().unwrap().to_string(),
                    entry["msg"].clone(),
                )
            })
            .collect();
        Self { dir, lines }
    }

    fn project(&self, file: &str) -> String {
        self.dir
            .path()
            .join("svode-e06")
            .join(file)
            .to_str()
            .unwrap()
            .to_string()
    }

    fn scratch(&self) -> String {
        self.dir
            .path()
            .join("scratch")
            .to_str()
            .unwrap()
            .to_string()
    }

    /// Runs the log through the normalizer and a projection per phase.
    fn run(&self, agent: AgentAdapterKind, retention: Retention) -> Run {
        let project = self.dir.path().join("svode-e06");
        let mut live = projection(agent, false, retention, &project);
        let mut replay = projection(agent, true, retention, &project);
        let mut turns = 0;
        for (phase, message) in &self.lines {
            let target = match phase.as_str() {
                "live" => &mut live,
                _ => &mut replay,
            };
            match message.get("method").and_then(Value::as_str) {
                Some("session/prompt") => {
                    if let Some(turn) = target.subscribe().snapshot.turn.turn_id.clone() {
                        target.finish_turn(&turn, StopReason::EndTurn, None);
                    }
                    turns += 1;
                    target.begin_turn(&format!("turn{turns}"), "prompt", Vec::new());
                }
                Some("session/update") => {
                    let (_, normalized) =
                        normalize::session_update(message["params"].clone(), Some(agent)).unwrap();
                    target.apply(normalized);
                }
                Some("session/request_permission") => {
                    let request =
                        normalize::permission_request(&message["params"].to_string(), Some(agent))
                            .unwrap();
                    target.merge_tool_call(request.tool_call);
                }
                _ => {}
            }
        }
        for target in [&mut live, &mut replay] {
            if let Some(turn) = target.subscribe().snapshot.turn.turn_id.clone() {
                target.finish_turn(&turn, StopReason::EndTurn, None);
            }
        }
        replay.end_replay();
        Run { live, replay }
    }
}

fn projection(
    agent: AgentAdapterKind,
    replay: bool,
    retention: Retention,
    cwd: &Path,
) -> Projection {
    let history = match replay {
        true => HistoryState {
            source: HistorySource::Replay,
            available: true,
            truncated_items: None,
        },
        false => Projection::live_history(),
    };
    Projection::new(
        SessionKey::from_acp(agent.as_str(), "s1", false),
        cwd.to_path_buf(),
        ConnectionState::Ready,
        history,
        replay,
        WriterState::Acp,
        retention,
        Arc::new(AtomicUsize::new(0)),
    )
}

struct Run {
    live: Projection,
    replay: Projection,
}

fn snapshot(projection: &Projection) -> SessionSnapshot {
    projection.subscribe().snapshot
}

fn item(projection: &Projection, id: &str) -> ActivityItem {
    snapshot(projection)
        .items
        .into_iter()
        .find(|item| item.id == id)
        .unwrap_or_else(|| panic!("no item {id}"))
}

fn media(projection: &Projection, id: &str) -> Vec<MediaSegment> {
    match item(projection, id).kind {
        ItemKind::ToolCall { media, .. } | ItemKind::AgentMessage { media } => media,
        other => panic!("{id} is {other:?}"),
    }
}

/// Every tool call with media, in order, with its segments.
fn all_media(projection: &Projection) -> Vec<Vec<MediaSegment>> {
    snapshot(projection)
        .items
        .into_iter()
        .filter_map(|item| match item.kind {
            ItemKind::ToolCall { media, .. } if !media.is_empty() => Some(media),
            _ => None,
        })
        .collect()
}

fn text(projection: &Projection, id: &str) -> String {
    match projection.detail(id) {
        DetailOutcome::Available { blocks } => blocks
            .iter()
            .map(|block| match block {
                DetailBlock::Text { text } => text.clone(),
                other => format!("{other:?}"),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        other => panic!("{id}: {other:?}"),
    }
}

fn file(kind: MediaKind, path: &str, mime: Option<&str>) -> MediaSegment {
    sized_file(kind, path, mime, None)
}

/// A file the agent also sent the data of, which is not kept.
fn sized_file(kind: MediaKind, path: &str, mime: Option<&str>, size: Option<u64>) -> MediaSegment {
    MediaSegment {
        id: "0".into(),
        kind,
        name: Path::new(path)
            .file_name()
            .map(|name| name.to_str().unwrap().to_string()),
        mime_type: mime.map(str::to_string),
        path: Some(path.to_string()),
        size,
        has_data: false,
        offset: None,
    }
}

fn numbered(segments: Vec<MediaSegment>) -> Vec<MediaSegment> {
    segments
        .into_iter()
        .enumerate()
        .map(|(index, segment)| MediaSegment {
            id: index.to_string(),
            ..segment
        })
        .collect()
}

fn assert_data(projection: &Projection, id: &str, segment: &str, mime: &str, data: &str) {
    match projection.media(id, segment) {
        MediaOutcome::Available {
            mime_type,
            data: held,
        } => {
            assert_eq!(mime_type, mime, "{id}/{segment}");
            assert!(held == data, "{id}/{segment}: other data");
        }
        other => panic!("{id}/{segment}: {other:?}"),
    }
}

/// The snapshot carries no media data, neither the placeholders' nor the
/// real base64 some logs kept.
fn assert_no_data_in_snapshot(projection: &Projection) {
    let json = serde_json::to_string(&snapshot(projection)).unwrap();
    assert!(!json.contains(&data(PIXEL.0, PIXEL.1)[..64]));
    assert!(!json.contains("iVBORw0KGgoAAAANSUhEUg"));
}

fn data_segment(kind: MediaKind, mime: &str, path: Option<&str>, size: u64) -> MediaSegment {
    MediaSegment {
        id: "0".into(),
        kind,
        name: path.and_then(|path| Path::new(path).file_name()?.to_str().map(str::to_string)),
        mime_type: Some(mime.into()),
        path: path.map(str::to_string),
        size: Some(size),
        has_data: true,
        offset: None,
    }
}

const PIXEL_SIZE: u64 = (PIXEL.0 as u64) * 3 / 4;

#[test]
fn claude_code_reads_with_data_and_names_its_mcp_media_by_its_markers() {
    let fixture = Fixture::load("claude-code");
    let run = fixture.run(AgentAdapterKind::ClaudeCode, Retention::default());
    let pixel = fixture.project("pixel.png");
    for projection in [&run.live, &run.replay] {
        let read = "toolu_01DCdnRZoNC9v83uy3HpmKiE";
        assert_eq!(
            media(projection, read),
            vec![data_segment(
                MediaKind::Image,
                "image/png",
                Some(&pixel),
                PIXEL_SIZE
            )]
        );
        assert_data(projection, read, "0", "image/png", &data(PIXEL.0, PIXEL.1));
        assert!(
            !item(projection, read).has_detail,
            "one copy: the data of the content, raw output and `_meta` is the segment"
        );

        let probe = "toolu_0177ghoisJPU5d8TFXtCEDcR";
        let results = "/Users/user/.claude/projects/-Users-user-Documents-svode-e06/a23de5e6-d4df-4fea-8887-938fd59ea619/tool-results";
        assert_eq!(
            media(projection, probe),
            numbered(vec![
                sized_file(
                    MediaKind::Image,
                    &format!("{results}/mcp-svode_probe-blob-1791433863443-r6tihm.png"),
                    Some("image/png"),
                    Some(PIXEL_SIZE)
                ),
                file(
                    MediaKind::Audio,
                    &format!("{results}/mcp-svode_probe-blob-1791433863443-e69yi7.wav"),
                    Some("audio/wav")
                ),
            ])
        );
        assert_eq!(
            text(projection, probe),
            "E06 probe media: image and audio follow."
        );
        assert_eq!(
            projection.media(probe, "0"),
            MediaOutcome::Unavailable {
                reason: UnavailableReason::NotProvided
            },
            "a file replaces its data"
        );
        assert_no_data_in_snapshot(projection);
    }
    assert_eq!(all_media(&run.live), all_media(&run.replay));
}

#[test]
fn codex_generation_is_its_file_and_an_mcp_result_holds_the_data() {
    let fixture = Fixture::load("codex");
    let run = fixture.run(AgentAdapterKind::Codex, Retention::default());
    let generated = "/Users/user/.codex/generated_images/01a119c8-7195-7722-8c9c-79b4f665b9d8";
    for projection in [&run.live, &run.replay] {
        for (call, encoded) in [
            ("exec-e8edb32e-45e3-47ff-b78b-5a373d6c96f9", 1336216),
            ("exec-bd059187-c129-417b-8bad-ec55a656675f", 1344708),
            ("exec-c9916863-e5c6-4e67-9754-d08c4e42e1e5", 1430628),
        ] {
            assert_eq!(
                media(projection, call),
                vec![sized_file(
                    MediaKind::Image,
                    &format!("{generated}/{call}.png"),
                    Some("image/png"),
                    Some(encoded * 3 / 4)
                )]
            );
            assert!(text(projection, call).starts_with("Revised prompt: "));
        }
        let mcp = "exec-c74bd3b5-1887-491c-bc2f-250699b4041a";
        assert_eq!(
            media(projection, mcp),
            vec![data_segment(
                MediaKind::Image,
                "image/png",
                None,
                PIXEL_SIZE
            )]
        );
        assert_data(projection, mcp, "0", "image/png", &data(PIXEL.0, PIXEL.1));
        let output = text(projection, mcp);
        assert!(output.contains("[base64 data, 12.4 KB]"), "{output}");
        assert!(!output.contains(&data(PIXEL.0, PIXEL.1)[..64]));
        assert!(
            media(projection, "exec-bcc91481-3337-496d-98bd-607e17e7fe53").is_empty(),
            "a result without media"
        );
        assert_no_data_in_snapshot(projection);
    }
    assert_eq!(all_media(&run.live), all_media(&run.replay));
}

#[test]
fn codex_view_image_is_the_file_it_links() {
    let fixture = Fixture::load("codex-view-image");
    let run = fixture.run(AgentAdapterKind::Codex, Retention::default());
    assert_eq!(
        media(&run.live, "exec-db33e02e-85cb-4dbf-9cb4-464ff5e67610"),
        vec![file(MediaKind::Image, &fixture.project("pixel.png"), None)]
    );
}

#[test]
fn a_read_without_data_shows_the_media_file_of_its_locations() {
    for (name, agent, read, replayed) in [
        (
            "qwen-code-read-text-edit",
            AgentAdapterKind::QwenCode,
            "call_9bec2ea26121",
            "call_9bec2ea26121",
        ),
        (
            "cursor",
            AgentAdapterKind::Cursor,
            "call-37bd3cc3-a840-4681-a925-b1dbd60ad039-0\nfc_85fe8937-3da1-97e9-8a6e-80385442710d_0",
            "replay-0-2",
        ),
    ] {
        let fixture = Fixture::load(name);
        let run = fixture.run(agent, Retention::default());
        let pixel = vec![file(MediaKind::Image, &fixture.project("pixel.png"), None)];
        assert_eq!(media(&run.live, read), pixel, "{name}");
        assert_eq!(media(&run.replay, replayed), pixel, "{name} replay");
        assert_eq!(
            all_media(&run.live),
            vec![pixel.clone()],
            "{name}: only the image"
        );
        assert_eq!(all_media(&run.replay), vec![pixel], "{name} replay");
    }
}

#[test]
fn grok_build_and_opencode_reads_hold_one_copy_named_by_locations() {
    let fixture = Fixture::load("grok-build");
    let run = fixture.run(AgentAdapterKind::GrokBuild, Retention::default());
    let pixel = fixture.project("pixel.png");
    let read = "call-12e247e1-5e10-409f-b502-506ca7c03d62-0";
    for projection in [&run.live, &run.replay] {
        assert_eq!(
            media(projection, read),
            vec![data_segment(
                MediaKind::Image,
                "image/png",
                Some(&pixel),
                PIXEL_SIZE
            )]
        );
        assert_data(projection, read, "0", "image/png", &data(PIXEL.0, PIXEL.1));
        assert!(
            !item(projection, read).has_detail,
            "one copy: `rawOutput.ImageContent` is not kept"
        );
        assert!(
            media(projection, "call-a4588ee0-923e-4f47-a906-bf87002da8dd-2").is_empty(),
            "Grok Build does not pass MCP media"
        );
        assert_no_data_in_snapshot(projection);
    }
    assert_eq!(all_media(&run.live), all_media(&run.replay));

    let fixture = Fixture::load("opencode-read-text-edit");
    let run = fixture.run(AgentAdapterKind::Opencode, Retention::default());
    assert_eq!(
        media(&run.replay, "call_6e70ed6da9e4"),
        vec![data_segment(
            MediaKind::Image,
            "image/png",
            Some(&fixture.project("pixel.png")),
            PIXEL_SIZE
        )]
    );
    assert_eq!(
        text(&run.replay, "call_6e70ed6da9e4"),
        "Image read successfully"
    );
}

#[test]
fn opencode_mcp_media_are_blocks_live_and_in_replay() {
    let fixture = Fixture::load("opencode-mcp");
    let run = fixture.run(AgentAdapterKind::Opencode, Retention::default());
    for projection in [&run.live, &run.replay] {
        assert_eq!(
            media(projection, "call_16b2dabc77f1"),
            vec![data_segment(
                MediaKind::Image,
                "image/png",
                None,
                PIXEL_SIZE
            )]
        );
        assert_data(
            projection,
            "call_16b2dabc77f1",
            "0",
            "image/png",
            &data(PIXEL.0, PIXEL.1),
        );
    }
}

#[test]
fn pi_reads_its_image_from_the_raw_output_of_both_forms() {
    let fixture = Fixture::load("pi");
    let run = fixture.run(AgentAdapterKind::Pi, Retention::default());
    let read = "call_3a1920afa8f2";
    assert_eq!(
        media(&run.live, read),
        vec![data_segment(
            MediaKind::Image,
            "image/png",
            Some(&fixture.project("pixel.png")),
            PIXEL_SIZE
        )]
    );
    assert_eq!(
        media(&run.replay, read),
        vec![data_segment(
            MediaKind::Image,
            "image/png",
            None,
            PIXEL_SIZE
        )],
        "pi replays without `locations`"
    );
    for projection in [&run.live, &run.replay] {
        assert_data(projection, read, "0", "image/png", &data(PIXEL.0, PIXEL.1));
        assert_eq!(text(projection, read), "Read image file [image/png]");
        assert!(media(projection, "call_f5cea3710724").is_empty());
    }
}

#[test]
fn kimi_code_holds_data_urls_live_and_takes_files_from_its_markers_in_replay() {
    let fixture = Fixture::load("kimi-code");
    let run = fixture.run(AgentAdapterKind::KimiCode, Retention::default());

    let read = "1:call_705bb5285978";
    assert_eq!(
        media(&run.live, read),
        vec![data_segment(MediaKind::Image, "image/png", None, 12718)],
        "the size of the real data Kimi Code sent"
    );
    let probe = "2:call_1740243c8f31";
    let segments = media(&run.live, probe);
    assert_eq!(
        segments
            .iter()
            .map(|segment| (segment.kind, segment.mime_type.as_deref(), segment.has_data))
            .collect::<Vec<_>>(),
        vec![
            (MediaKind::Image, Some("image/png"), true),
            (MediaKind::Audio, Some("audio/wav"), true),
        ]
    );
    for (id, segment) in [(read, "0"), (probe, "0")] {
        let MediaOutcome::Available { data, .. } = run.live.media(id, segment) else {
            panic!("{id}: data");
        };
        assert!(data.starts_with("iVBORw0KGgo") && data.len() == PIXEL.0);
    }
    let output = text(&run.live, probe);
    assert!(output.contains("[image/png, 12.4 KB]"), "{output}");
    assert!(output.contains("[audio/wav, 4.7 KB]"), "{output}");
    assert!(!output.contains("iVBORw0KGgo"));
    assert_no_data_in_snapshot(&run.live);

    assert_eq!(
        media(&run.replay, "2:call_705bb5285978"),
        vec![file(MediaKind::Image, &fixture.project("pixel.png"), None)]
    );
    assert_eq!(text(&run.replay, "2:call_705bb5285978"), "");
    let store = format!(
        "{}/kimi-home/.kimi-code/sessions/wd_svode-e06_8d57dcc50759/session_767e8b39-4e3e-44a5-aa86-69406e4fc19d/media",
        fixture.scratch()
    );
    assert_eq!(
        media(&run.replay, "4:call_1740243c8f31"),
        numbered(vec![
            file(
                MediaKind::Image,
                &format!(
                    "{store}/f_mcp_9f9d02eb4f9677295860cac5f3ec7c8a4c86bf6f4b887c05fda07559e6c5b1e5.png"
                ),
                None
            ),
            file(
                MediaKind::Audio,
                &format!(
                    "{store}/f_mcp_84860988fea052e3cfb2f7177ecd584a7ef2d9ce8867bdace12d86490485c2d8.wav"
                ),
                None
            ),
        ])
    );
    let replayed = text(&run.replay, "4:call_1740243c8f31");
    assert!(!replayed.contains("[image_url]") && !replayed.contains("Original attachment"));
    assert!(replayed.contains("Attachment reference"));
}

#[test]
fn hermes_media_lines_of_a_tool_result_are_files_live_and_in_replay() {
    let fixture = Fixture::load("hermes");
    let run = fixture.run(AgentAdapterKind::Hermes, Retention::default());
    let cache = "/Users/user/.hermes/cache";
    let probe = numbered(vec![
        file(
            MediaKind::Image,
            &format!("{cache}/images/img_2a66c6ef2ea4.png"),
            None,
        ),
        file(
            MediaKind::Audio,
            &format!("{cache}/audio/audio_7e2c2f729e49.wav"),
            None,
        ),
    ]);
    assert_eq!(media(&run.live, "tc-afabd410c09c"), probe);
    assert_eq!(
        text(&run.live, "tc-afabd410c09c"),
        "mcp__svode_probe__probe_media result\n- **result:** E06 probe media: image and audio follow.\n"
    );
    assert_eq!(media(&run.replay, "call_smivjndOPmgpwjxViIHBn5Pc"), probe);
    let replayed = text(&run.replay, "call_smivjndOPmgpwjxViIHBn5Pc");
    assert!(!replayed.contains("MEDIA:"), "{replayed}");
    assert!(replayed.contains("{\"result\": \"E06 probe media: image and audio follow.\"}"));
    assert_eq!(all_media(&run.live), all_media(&run.replay));

    // `vision_analyze` does not pass the image: no segment, and its data
    // URL is a size mark in the text.
    assert!(media(&run.live, "tc-5f37adf26e93").is_empty());
    let vision = text(&run.live, "tc-5f37adf26e93");
    assert!(vision.contains("[image/png, 12.4 KB]"), "{vision}");
    assert_no_data_in_snapshot(&run.live);
}

#[test]
fn agents_that_do_not_pass_mcp_media_get_no_segments() {
    for (name, agent) in [
        ("qwen-code-mcp", AgentAdapterKind::QwenCode),
        ("grok-build", AgentAdapterKind::GrokBuild),
        ("cursor", AgentAdapterKind::Cursor),
    ] {
        let fixture = Fixture::load(name);
        let run = fixture.run(agent, Retention::default());
        for projection in [&run.live, &run.replay] {
            let probes: Vec<_> = snapshot(projection)
                .items
                .into_iter()
                .filter(|item| {
                    matches!(item.kind, ItemKind::ToolCall { .. })
                        && item.summary.contains("probe_media")
                        && !item.summary.starts_with("ToolSearch")
                        && !item.summary.starts_with("Search tools")
                })
                .collect();
            assert!(!probes.is_empty(), "{name}");
            for probe in probes {
                assert!(
                    media(projection, &probe.id).is_empty(),
                    "{name} {}",
                    probe.summary
                );
            }
        }
    }
    let fixture = Fixture::load("qwen-code-mcp");
    let run = fixture.run(AgentAdapterKind::QwenCode, Retention::default());
    assert!(
        text(&run.live, "call_a913ed9a15ae").contains(
            "[Tool 'probe_media' provided the following image data with mime-type: image/png]"
        ),
        "the text stays as the agent sent it"
    );
}

#[test]
fn media_beyond_the_item_bound_is_too_large_and_a_release_keeps_the_segment() {
    let fixture = Fixture::load("claude-code");
    let read = "toolu_01DCdnRZoNC9v83uy3HpmKiE";
    let run = fixture.run(
        AgentAdapterKind::ClaudeCode,
        Retention {
            media_item: 1000,
            ..Retention::default()
        },
    );
    assert!(media(&run.live, read)[0].has_data);
    assert_eq!(
        run.live.media(read, "0"),
        MediaOutcome::Unavailable {
            reason: UnavailableReason::TooLarge
        }
    );

    let mut run = fixture.run(AgentAdapterKind::ClaudeCode, Retention::default());
    assert!(run.live.release_detail(usize::MAX) >= PIXEL.0);
    assert_eq!(
        media(&run.live, read),
        vec![data_segment(
            MediaKind::Image,
            "image/png",
            Some(&fixture.project("pixel.png")),
            PIXEL_SIZE
        )],
        "the segment stays"
    );
    assert_eq!(
        run.live.media(read, "0"),
        MediaOutcome::Unavailable {
            reason: UnavailableReason::Released
        }
    );
    assert!(matches!(
        run.live.media(read, "9"),
        MediaOutcome::Error { .. }
    ));
    assert!(matches!(
        run.live.media("missing", "0"),
        MediaOutcome::Error { .. }
    ));
}

fn agent_chunk(content: Value) -> Normalized {
    normalize::session_update(
        json!({
            "sessionId": "s1",
            "update": { "sessionUpdate": "agent_message_chunk", "content": content, "messageId": "m1" }
        }),
        None,
    )
    .unwrap()
    .1
}

#[test]
fn media_blocks_of_an_agent_message_stand_at_their_place_in_its_text() {
    let mut projection = projection(
        AgentAdapterKind::Codex,
        false,
        Retention::default(),
        Path::new("/project"),
    );
    projection.begin_turn("t1", "hi", Vec::new());
    projection.apply(agent_chunk(json!({ "type": "text", "text": "Here é" })));
    projection.apply(agent_chunk(
        json!({ "type": "image", "mimeType": "image/png", "data": "iVBORw==" }),
    ));
    projection.apply(agent_chunk(json!({ "type": "text", "text": " and " })));
    projection.apply(agent_chunk(json!({
        "type": "resource_link", "uri": "file:///tmp/a%20b.mp4", "name": "a b.mp4", "size": 2048
    })));
    projection.apply(agent_chunk(json!({
        "type": "resource", "resource": { "uri": "file:///tmp/notes.md", "text": " notes" }
    })));
    projection.apply(agent_chunk(json!({
        "type": "resource_link", "uri": "https://example.com/a.png", "name": "a.png"
    })));

    let message = item(&projection, "m1");
    assert_eq!(
        message.summary,
        "Here é and  noteshttps://example.com/a.png"
    );
    assert_eq!(
        media(&projection, "m1"),
        vec![
            MediaSegment {
                id: "0".into(),
                kind: MediaKind::Image,
                name: None,
                mime_type: Some("image/png".into()),
                path: None,
                size: Some(4),
                has_data: true,
                offset: Some(6),
            },
            MediaSegment {
                id: "1".into(),
                kind: MediaKind::Video,
                name: Some("a b.mp4".into()),
                mime_type: None,
                path: Some("/tmp/a b.mp4".into()),
                size: Some(2048),
                has_data: false,
                offset: Some(11),
            },
        ]
    );
    assert_eq!(
        projection.media("m1", "0"),
        MediaOutcome::Available {
            mime_type: "image/png".into(),
            data: "iVBORw==".into()
        }
    );
    assert_eq!(
        projection.media("m1", "1"),
        MediaOutcome::Unavailable {
            reason: UnavailableReason::NotProvided
        }
    );
}

#[test]
fn an_mcp_result_counts_only_in_a_call_of_the_codex_mcp_form() {
    let update = |update: Value| {
        normalize::session_update(
            json!({ "sessionId": "s1", "update": update }),
            Some(AgentAdapterKind::Codex),
        )
        .unwrap()
        .1
    };
    let result = json!({ "result": { "content": [
        { "type": "image", "mimeType": "image/png", "data": "iVBORw==" }
    ] } });
    let mut projection = projection(
        AgentAdapterKind::Codex,
        false,
        Retention::default(),
        Path::new("/project"),
    );
    projection.begin_turn("t1", "hi", Vec::new());
    projection.apply(update(json!({
        "sessionUpdate": "tool_call", "toolCallId": "mcp", "kind": "execute",
        "title": "mcp.probe.media", "status": "in_progress", "_meta": { "is_mcp_tool_call": true }
    })));
    projection.apply(update(json!({
        "sessionUpdate": "tool_call_update", "toolCallId": "mcp", "status": "completed", "rawOutput": result
    })));
    projection.apply(update(json!({
        "sessionUpdate": "tool_call", "toolCallId": "look-alike", "kind": "execute",
        "title": "mcp.probe.media", "status": "in_progress"
    })));
    projection.apply(update(json!({
        "sessionUpdate": "tool_call_update", "toolCallId": "look-alike", "status": "completed", "rawOutput": result
    })));
    assert_eq!(media(&projection, "mcp").len(), 1);
    assert!(media(&projection, "look-alike").is_empty());
}

/// The Svode MCP call of an E06 log by its tool, with the files it changes
/// and its MCP calls.
fn svode_call(projection: &Projection, tool: &str) -> (Vec<ToolLocation>, Vec<McpCallRef>) {
    snapshot(projection)
        .items
        .into_iter()
        .find_map(|item| match item.kind {
            ItemKind::ToolCall {
                locations,
                mcp_calls,
                ..
            } if mcp_calls.iter().any(|call| call.tool == tool) => Some((locations, mcp_calls)),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no call of {tool}"))
}

#[test]
fn svode_mcp_calls_of_codex_and_claude_code_name_their_pages_live_and_in_replay() {
    for (agent, name, server, page) in [
        (
            AgentAdapterKind::Codex,
            "codex",
            "svode",
            "notes/E06 codex page.md",
        ),
        (
            AgentAdapterKind::ClaudeCode,
            "claude-code",
            "plugin_svode_svode",
            "notes/E06 page.md",
        ),
    ] {
        let fixture = Fixture::load(name);
        let run = fixture.run(agent, Retention::default());
        let live = svode_call(&run.live, "create_page");
        assert_eq!(live, svode_call(&run.replay, "create_page"), "{name}");
        let project = PathBuf::from(fixture.project("")).canonicalize().unwrap();
        assert_eq!(
            live,
            (
                vec![ToolLocation {
                    path: project.join(page).to_string_lossy().into_owned(),
                    change: Some(FileChange::Created),
                    lines: None,
                }],
                vec![McpCallRef {
                    server: server.into(),
                    tool: "create_page".into(),
                    changes_project: true,
                }],
            ),
            "{name}"
        );
        // The probe server is an MCP call too, but not Svode's.
        let (locations, calls) = svode_call(&run.live, "probe_media");
        assert!(locations.is_empty() && !calls[0].changes_project, "{name}");
    }
}

#[test]
fn inline_data_beyond_the_limit_becomes_a_size_mark() {
    let long = data(4000, "0a1b2c");
    assert_eq!(
        scrub_inline_data(&format!("before data:image/jpeg;base64,{long} after")),
        "before [image/jpeg, 2.9 KB] after"
    );
    assert_eq!(
        scrub_inline_data(&format!("{{\"data\":\"{long}\"}}")),
        "{\"data\":\"[base64 data, 2.9 KB]\"}"
    );
    let short = "see data:image/png;base64,iVBORw== and AAAA1111bbbb";
    assert_eq!(scrub_inline_data(short), short);
    let word = "x".repeat(4000);
    assert_eq!(scrub_inline_data(&word), word, "a long word is not base64");
    let text = format!("é{long}ж");
    assert_eq!(scrub_inline_data(&text), "é[base64 data, 2.9 KB]ж");
}

#[test]
fn media_lines_follow_the_media_line_rule() {
    let home = system_home_dir().unwrap();
    let (rest, paths) = media_lines(
        "Done.\nMEDIA:/a/one.png\nsee MEDIA:\"/a/two words.wav\" [[audio_as_voice]]\nMEDIA:`~/three.mp4`.\n`MEDIA:/a/code.png`\n```\nMEDIA:/a/fenced.png\n```\nxMEDIA:/a/glued.png\nMEDIA:relative.png\n",
    );
    assert_eq!(
        paths,
        vec![
            "/a/one.png".to_string(),
            "/a/two words.wav".to_string(),
            home.join("three.mp4").to_str().unwrap().to_string(),
        ]
    );
    assert_eq!(
        rest,
        "Done.\nsee  \n.\n`MEDIA:/a/code.png`\n```\nMEDIA:/a/fenced.png\n```\nxMEDIA:/a/glued.png\nMEDIA:relative.png\n"
    );
    assert_eq!(
        media_lines("no media"),
        ("no media".to_string(), Vec::new())
    );
}

#[test]
fn local_paths_are_absolute_paths_and_file_uris() {
    assert_eq!(
        local_path("file:///tmp/a%20b.png").as_deref(),
        Some("/tmp/a b.png")
    );
    assert_eq!(
        local_path("file://localhost/tmp/a.png").as_deref(),
        Some("/tmp/a.png")
    );
    assert_eq!(local_path("/tmp/a.png").as_deref(), Some("/tmp/a.png"));
    assert_eq!(local_path("relative/a.png"), None);
    assert_eq!(local_path("https://example.com/a.png"), None);
    assert_eq!(local_path("file:///tmp/%zz"), None);
    assert_eq!(local_path(&format!("/{}", "a".repeat(URI_LIMIT))), None);
}
