//! A user message of a Routine launch shows its instruction without the
//! block the launch appends (DF-224 R1): live and in replay, whole or in
//! chunks, within or beyond the detail bound.

use serde_json::{Value, json};

use super::*;
use crate::identity::IdentityNamespace;
use crate::registry::{AdapterRuntimeRegistry, ManualRoutineLaunchInput};

const INSTRUCTION: &str =
    "Run the shell command ping -c 90 127.0.0.1\nand then reply with exactly one word: done";

fn projection(agent: &str, replay: bool, retention: Retention) -> Projection {
    Projection::new(
        SessionKey {
            agent: agent.into(),
            namespace: IdentityNamespace::Acp,
            session_id: "s1".into(),
        },
        PathBuf::from("/project"),
        ConnectionState::Ready,
        Projection::live_history(),
        replay,
        WriterState::None,
        retention,
        Arc::new(AtomicUsize::new(0)),
    )
}

fn input(instruction: &str, event_context: Option<&str>) -> ManualRoutineLaunchInput {
    ManualRoutineLaunchInput {
        instruction: instruction.into(),
        launch_id: "01jz8x7d1qk3v".into(),
        owner_kind: "project".into(),
        owner_path: ".".into(),
        event_context: event_context.map(str::to_string),
    }
}

/// The first prompt of an ACP Routine launch: no launch marker.
fn acp_prompt(instruction: &str, event_context: Option<&str>) -> String {
    AdapterRuntimeRegistry.acp_routine_prompt(&input(instruction, event_context))
}

/// The prompt of a terminal Routine launch: the ACP one with the launch
/// marker after the owner marker.
fn terminal_prompt(instruction: &str, event_context: Option<&str>) -> String {
    let prompt = acp_prompt(instruction, event_context);
    let owner = prompt.rfind("<!-- svode-owner:").unwrap();
    let owner_end = owner + prompt[owner..].find(" -->").unwrap() + " -->".len();
    format!(
        "{}\n<!-- svode-launch:01jz8x7d1qk3v -->{}",
        &prompt[..owner_end],
        &prompt[owner_end..]
    )
}

fn apply(projection: &mut Projection, agent: &str, update: Value) {
    let (_, normalized) = normalize::session_update(
        json!({ "sessionId": "s1", "update": update }),
        AgentAdapterKind::from_id(agent),
    )
    .unwrap();
    projection.apply(normalized);
}

fn user_chunk(text: &str) -> Value {
    json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "text", "text": text } })
}

fn agent_chunk(text: &str) -> Value {
    json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": text } })
}

fn users(projection: &Projection) -> Vec<&ActivityItem> {
    projection
        .snapshot
        .items
        .iter()
        .filter(|item| matches!(item.kind, ItemKind::UserMessage { .. }))
        .collect()
}

/// The one user message shows `text` in its summary and its detail.
fn assert_shows(projection: &Projection, text: &str, case: &str) {
    let users = users(projection);
    assert_eq!(users.len(), 1, "{case}");
    let user = users[0];
    assert_eq!(user.summary, text, "{case}");
    assert_eq!(
        user.kind,
        ItemKind::UserMessage {
            segments: Vec::new()
        },
        "{case}"
    );
    assert_eq!(
        projection.detail(&user.id),
        DetailOutcome::Available {
            blocks: vec![DetailBlock::Text { text: text.into() }]
        },
        "{case}"
    );
}

#[test]
fn the_live_first_turn_of_a_routine_launch_shows_only_its_instruction() {
    let context = r#"{"entryPath":"tasks/a.md","eventType":"collection.entry_created"}"#;
    for (case, prompt) in [
        ("acp", acp_prompt(INSTRUCTION, None)),
        ("acp event", acp_prompt(INSTRUCTION, Some(context))),
        ("terminal", terminal_prompt(INSTRUCTION, None)),
        (
            "terminal event",
            terminal_prompt(INSTRUCTION, Some(context)),
        ),
    ] {
        let mut projection = projection("qwen-code", false, Retention::default());
        projection.begin_turn("t1", &prompt, Vec::new()).unwrap();
        assert_shows(&projection, INSTRUCTION, case);
        assert!(!users(&projection)[0].has_detail, "{case}");
        assert_eq!(projection.snapshot.turn.phase, TurnPhase::Running, "{case}");
    }
}

#[test]
fn a_replayed_routine_message_shows_only_its_instruction_however_it_is_chunked() {
    let prompt = terminal_prompt(INSTRUCTION, None);
    let boundaries: Vec<usize> = (1..prompt.len())
        .filter(|&index| prompt.is_char_boundary(index))
        .collect();
    for agent in ["codex", "claude-code"] {
        let mut splits = vec![vec![prompt.as_str()]];
        // Two chunks at every boundary, the block among them.
        splits.extend(
            boundaries
                .iter()
                .map(|&at| vec![&prompt[..at], &prompt[at..]]),
        );
        // A chunk per line, as an agent that streams lines replays it.
        splits.push(prompt.split_inclusive('\n').collect());
        for chunks in splits {
            let case = format!("{agent} {chunks:?}");
            let mut projection = projection(agent, true, Retention::default());
            for chunk in &chunks {
                apply(&mut projection, agent, user_chunk(chunk));
            }
            apply(&mut projection, agent, agent_chunk("done"));
            projection.end_replay();
            assert_shows(&projection, INSTRUCTION, &case);
            let items: Vec<_> = projection
                .snapshot
                .items
                .iter()
                .map(|item| (item.turn_id.as_deref(), item.summary.as_str()))
                .collect();
            assert_eq!(
                items,
                vec![(Some("replay:1"), INSTRUCTION), (Some("replay:1"), "done")],
                "{case}"
            );
        }
    }
}

#[test]
fn an_instruction_beyond_the_detail_bound_keeps_its_head_and_its_tail_without_the_block() {
    let retention = Retention {
        item_detail: 1024,
        ..Retention::default()
    };
    let instruction = format!("Start {} end of the task", "word ".repeat(400));
    let prompt = terminal_prompt(
        &instruction,
        Some(r#"{"eventType":"collection.field_changed"}"#),
    );
    let expected = excerpt(instruction.clone(), retention.item_detail);
    let DetailBlock::Excerpt {
        head,
        tail: expected_tail,
        ..
    } = &expected
    else {
        panic!("not an excerpt");
    };

    let mut live = projection("qwen-code", false, retention);
    live.begin_turn("t1", &prompt, Vec::new()).unwrap();
    let mut replay = projection("codex", true, retention);
    for chunk in prompt.as_bytes().chunks(100) {
        apply(
            &mut replay,
            "codex",
            user_chunk(std::str::from_utf8(chunk).unwrap()),
        );
    }
    for (case, projection) in [("live", &live), ("replay", &replay)] {
        let user = users(projection)[0];
        assert!(user.has_detail, "{case}");
        assert_eq!(&user.summary, head, "{case}");
        let DetailOutcome::Available { blocks } = projection.detail(&user.id) else {
            panic!("{case}: no detail");
        };
        let [
            DetailBlock::Excerpt {
                head: shown_head,
                tail,
                ..
            },
        ] = blocks.as_slice()
        else {
            panic!("{case}: not an excerpt: {blocks:?}");
        };
        assert_eq!(shown_head, head, "{case}");
        assert!(tail.ends_with("end of the task"), "{case}: {tail:?}");
        assert!(expected_tail.ends_with(tail.as_str()), "{case}: {tail:?}");
        assert!(!tail.contains("svode-"), "{case}: {tail:?}");
    }
}

#[test]
fn marker_lookalikes_inside_the_instruction_stay() {
    let instruction =
        "Explain <!-- svode-owner:space:. --> and\n<!-- svode-launch:x --> to the team";
    let mut live = projection("qwen-code", false, Retention::default());
    live.begin_turn("t1", &acp_prompt(instruction, None), Vec::new())
        .unwrap();
    assert_shows(&live, instruction, "live");

    let mut replay = projection("claude-code", true, Retention::default());
    apply(
        &mut replay,
        "claude-code",
        user_chunk(&terminal_prompt(instruction, None)),
    );
    assert_shows(&replay, instruction, "replay");
}

#[test]
fn a_routine_message_with_an_empty_instruction_is_not_shown_and_its_turn_stays() {
    let mut live = projection("qwen-code", false, Retention::default());
    live.begin_turn("t1", &acp_prompt("  ", None), Vec::new())
        .unwrap();
    apply(&mut live, "qwen-code", agent_chunk("Nothing to do"));
    assert!(users(&live).is_empty());
    assert_eq!(live.snapshot.turn.phase, TurnPhase::Running);
    assert_eq!(live.snapshot.items.len(), 1);
    assert_eq!(live.snapshot.items[0].turn_id.as_deref(), Some("t1"));

    let prompt = terminal_prompt("", None);
    let (first, second) = prompt.split_at(prompt.len() / 2);
    for chunks in [vec![prompt.as_str()], vec![first, second]] {
        let mut replay = projection("codex", true, Retention::default());
        for chunk in &chunks {
            apply(&mut replay, "codex", user_chunk(chunk));
        }
        apply(&mut replay, "codex", agent_chunk("Nothing to do"));
        apply(&mut replay, "codex", user_chunk("Thanks"));
        let items: Vec<_> = replay
            .snapshot
            .items
            .iter()
            .map(|item| (item.turn_id.as_deref(), item.summary.as_str()))
            .collect();
        assert_eq!(
            items,
            vec![
                (Some("replay:1"), "Nothing to do"),
                (Some("replay:2"), "Thanks")
            ],
            "{chunks:?}"
        );
    }
}

#[test]
fn messages_without_a_whole_block_at_their_end_are_unchanged() {
    for text in [
        "Thanks",
        "Review backlog\n\n<!-- svode-owner:proj",
        "Review backlog\n\n<!-- svode-launch:01jz8x7d1qk3v -->",
        "Review <!-- svode-owner:project:. --> later",
    ] {
        let mut live = projection("qwen-code", false, Retention::default());
        live.begin_turn("t1", text, Vec::new()).unwrap();
        assert_shows(&live, text, "live");

        let mut replay = projection("codex", true, Retention::default());
        apply(&mut replay, "codex", user_chunk(text));
        replay.end_replay();
        assert_shows(&replay, text, "replay");
    }
}

#[test]
fn a_replayed_message_that_stays_the_start_of_a_block_is_shown_when_it_ends() {
    let text = "<!-- svode-owner:proj";
    let mut replay = projection("codex", true, Retention::default());
    apply(&mut replay, "codex", user_chunk(text));
    assert!(users(&replay).is_empty(), "a later chunk may complete it");
    apply(&mut replay, "codex", agent_chunk("done"));
    let items: Vec<_> = replay
        .snapshot
        .items
        .iter()
        .map(|item| (item.turn_id.as_deref(), item.summary.as_str()))
        .collect();
    assert_eq!(
        items,
        vec![(Some("replay:1"), text), (Some("replay:1"), "done")]
    );

    let mut replay = projection("codex", true, Retention::default());
    apply(&mut replay, "codex", user_chunk(text));
    replay.end_replay();
    assert_shows(&replay, text, "the replay ends");
}

#[test]
fn a_message_with_links_shows_its_segments_without_the_block() {
    let mut replay = projection("claude-code", true, Retention::default());
    apply(&mut replay, "claude-code", user_chunk("Look at "));
    apply(
        &mut replay,
        "claude-code",
        json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "resource_link", "uri": "file:///p/a.md", "name": "a.md" } }),
    );
    let prompt = terminal_prompt("please", None);
    let (first, second) = prompt.split_at(prompt.find("svode-owner").unwrap());
    apply(&mut replay, "claude-code", user_chunk(" "));
    apply(&mut replay, "claude-code", user_chunk(first));
    apply(&mut replay, "claude-code", user_chunk(second));

    let user = users(&replay)[0];
    assert_eq!(user.summary, "Look at @a.md please");
    assert_eq!(
        user.kind,
        ItemKind::UserMessage {
            segments: vec![
                MessageSegment::Text {
                    text: "Look at ".into()
                },
                MessageSegment::Link {
                    uri: "file:///p/a.md".into(),
                    name: "a.md".into()
                },
                MessageSegment::Text {
                    text: " please".into()
                },
            ]
        }
    );
}
