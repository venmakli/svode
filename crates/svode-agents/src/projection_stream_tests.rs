//! Streamed text items: each change of an item's detail reaches consumers
//! as a delta of that item (DF-195 R3), so a shown item can follow its
//! detail after its summary stops growing.

use serde_json::json;

use super::*;
use crate::identity::IdentityNamespace;

fn live_projection() -> Projection {
    Projection::new(
        SessionKey {
            agent: "claude-code".into(),
            namespace: IdentityNamespace::Acp,
            session_id: "s1".into(),
        },
        PathBuf::from("/project"),
        ConnectionState::Ready,
        Projection::live_history(),
        false,
        WriterState::None,
        Retention::default(),
        Arc::new(AtomicUsize::new(0)),
    )
}

#[test]
fn every_chunk_of_a_long_message_or_reasoning_sends_an_item_delta_and_the_detail_holds_the_whole_text()
 {
    let chunk = "word ".repeat(200);
    for update in ["agent_message_chunk", "agent_thought_chunk"] {
        let mut projection = live_projection();
        let mut deltas = projection.subscribe().deltas;
        let mut whole = String::new();
        let mut summaries = Vec::new();
        // Ten chunks of 1000 bytes: the text passes the 4 KB summary.
        for _ in 0..10 {
            let (_, normalized) = normalize::session_update(
                json!({
                    "sessionId": "s1",
                    "update": {
                        "sessionUpdate": update,
                        "content": { "type": "text", "text": chunk },
                    },
                }),
                AgentAdapterKind::from_id("claude-code"),
            )
            .unwrap();
            projection.apply(normalized);
            whole.push_str(&chunk);

            let delta = deltas.try_recv().expect("a delta for the chunk");
            let Change::Item(item) = delta.change else {
                panic!("{update}: not an item delta: {:?}", delta.change);
            };
            assert!(deltas.try_recv().is_err(), "{update}: one delta per chunk");
            assert_eq!(item.has_detail, whole.len() > SUMMARY_LIMIT, "{update}");
            assert_eq!(
                projection.detail(&item.id),
                DetailOutcome::Available {
                    blocks: vec![DetailBlock::Text {
                        text: whole.clone(),
                    }],
                },
                "{update}"
            );
            summaries.push(item.summary);
        }
        // Past the bound the summary stays: only the delta tells of the change.
        let bounded = &summaries[4..];
        assert!(
            bounded.iter().all(|summary| summary == &bounded[0]),
            "{update}"
        );
    }
}
