use std::time::Duration;

use svode_agents::activity::{
    Change, ConnectionState, HistorySource, HistoryState, InteractionState, PendingInteraction,
    SessionDelta, SessionSnapshot, TurnPhase, TurnState, WriterState,
};
use svode_agents::identity::{IdentityNamespace, SessionKey};
use svode_agents::status::{InteractionKind, SessionState, SessionStatus};
use tokio::sync::{broadcast, mpsc};

use super::*;

fn key() -> SessionKey {
    SessionKey {
        agent: "scripted".into(),
        namespace: IdentityNamespace::Acp,
        session_id: "s1".into(),
    }
}

fn snapshot(seq: u64) -> SessionSnapshot {
    SessionSnapshot {
        seq,
        session: key(),
        connection: ConnectionState::Ready,
        turn: TurnState {
            turn_id: None,
            phase: TurnPhase::None,
            last_outcome: None,
            status: SessionStatus::runtime(SessionState::Idle { stop_reason: None }),
        },
        items: Vec::new(),
        plan: None,
        pending: None,
        history: HistoryState {
            source: HistorySource::Live,
            available: true,
            truncated_items: None,
        },
        writer: WriterState::Acp,
    }
}

fn delta(seq: u64) -> SessionDelta {
    SessionDelta {
        seq,
        change: Change::Connection(ConnectionState::Ready),
    }
}

fn permission(state: InteractionState) -> PendingInteraction {
    PendingInteraction {
        id: "interaction:1".into(),
        kind: InteractionKind::Permission,
        title: "touch probe.txt".into(),
        options: Vec::new(),
        fields: Vec::new(),
        state,
    }
}

/// A delivery into a test sink; the sink stays open while `receiver` lives.
fn deliver(
    state: &AgentRuntimeState,
    webview: &str,
    snapshot: SessionSnapshot,
    deltas: broadcast::Receiver<SessionDelta>,
) -> (u64, mpsc::UnboundedReceiver<ActivityMessage>) {
    let (sender, receiver) = mpsc::unbounded_channel();
    let id = state.deliver(
        webview,
        SessionSubscription { snapshot, deltas },
        move |message| sender.send(message).is_ok(),
    );
    (id, receiver)
}

async fn next(receiver: &mut mpsc::UnboundedReceiver<ActivityMessage>) -> ActivityMessage {
    tokio::time::timeout(Duration::from_secs(5), receiver.recv())
        .await
        .expect("a message is delivered")
        .expect("the delivery is open")
}

async fn closed(receiver: &mut mpsc::UnboundedReceiver<ActivityMessage>) {
    let message = tokio::time::timeout(Duration::from_secs(5), receiver.recv())
        .await
        .expect("the delivery ends");
    assert!(message.is_none(), "unexpected message {message:?}");
}

async fn wait_for_count(state: &AgentRuntimeState, count: usize) {
    for _ in 0..500 {
        if state.subscription_count() == count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("expected {count} subscriptions");
}

#[tokio::test]
async fn the_snapshot_comes_first_then_the_deltas_after_it_in_order() {
    let state = AgentRuntimeState::new();
    let (sender, deltas) = broadcast::channel(16);
    let (_, mut receiver) = deliver(&state, "main", snapshot(4), deltas);

    let ActivityMessage::Snapshot(mut local) = next(&mut receiver).await else {
        panic!("the first message is the snapshot");
    };
    sender.send(delta(5)).unwrap();
    sender
        .send(SessionDelta {
            seq: 6,
            change: Change::Pending(permission(InteractionState::Pending)),
        })
        .unwrap();
    sender
        .send(SessionDelta {
            seq: 7,
            change: Change::Pending(permission(InteractionState::Answered)),
        })
        .unwrap();
    for seq in 5..=7 {
        let ActivityMessage::Delta(delta) = next(&mut receiver).await else {
            panic!("deltas follow the snapshot");
        };
        assert_eq!(delta.seq, seq);
        assert!(local.apply(&delta));
    }
    assert_eq!(local.seq, 7);
    assert_eq!(local.pending, None, "an answered request is not pending");
}

#[tokio::test]
async fn a_lagging_delivery_shows_the_consumer_a_seq_gap() {
    let state = AgentRuntimeState::new();
    let (sender, deltas) = broadcast::channel(2);
    for seq in 1..=5 {
        sender.send(delta(seq)).unwrap();
    }
    let (_, mut receiver) = deliver(&state, "main", snapshot(0), deltas);

    let ActivityMessage::Snapshot(mut local) = next(&mut receiver).await else {
        panic!("the first message is the snapshot");
    };
    let ActivityMessage::Delta(delta) = next(&mut receiver).await else {
        panic!("a delta follows");
    };
    assert!(delta.seq > local.seq + 1);
    assert!(!local.apply(&delta), "the consumer resubscribes on the gap");
}

#[tokio::test]
async fn a_webview_reload_drops_only_its_own_deliveries() {
    let state = AgentRuntimeState::new();
    let (sender, _) = broadcast::channel(16);
    let (_, mut reloaded) = deliver(&state, "main", snapshot(0), sender.subscribe());
    let (_, mut other) = deliver(&state, "project-2", snapshot(0), sender.subscribe());
    next(&mut reloaded).await;
    next(&mut other).await;

    state.release_webview("main");
    assert_eq!(state.subscription_count(), 1);
    closed(&mut reloaded).await;
    sender.send(delta(1)).unwrap();
    assert!(matches!(next(&mut other).await, ActivityMessage::Delta(_)));
}

#[tokio::test]
async fn unsubscribe_and_a_failed_send_end_the_delivery() {
    let state = AgentRuntimeState::new();
    let (sender, _) = broadcast::channel(16);
    let (id, mut receiver) = deliver(&state, "main", snapshot(0), sender.subscribe());
    next(&mut receiver).await;
    state.unsubscribe(id);
    closed(&mut receiver).await;
    state.unsubscribe(id);

    let (_, receiver) = deliver(&state, "main", snapshot(0), sender.subscribe());
    drop(receiver);
    wait_for_count(&state, 0).await;
    assert_eq!(
        sender.receiver_count(),
        0,
        "no delivery keeps the session subscribed"
    );
}

#[tokio::test]
async fn subscribing_to_an_unknown_session_is_a_typed_error() {
    let state = AgentRuntimeState::new();
    let error = state.subscribe("main", &key(), |_| true).unwrap_err();
    assert_eq!(error, AgentRuntimeError::SessionNotFound);
    assert_eq!(state.subscription_count(), 0);
}
