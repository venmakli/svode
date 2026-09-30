//! Writer ownership (Stage 10 `02` C7): within one Svode process a native
//! session has at most one managed writer, an ACP connection or a managed
//! PTY. A claim is taken before a start or continuation and released with
//! the writer; the host supplies what it knows about external processes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::identity::SessionKey;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Writer {
    Acp,
    Pty,
}

/// Evidence about a process outside Svode writing to the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalLiveness {
    /// A confirming check found no live external process.
    Free,
    /// Evidence of a live external process: manual fallback only.
    ExternalActive,
    /// No evidence either way; never treated as free.
    Unknown,
}

/// The user's explicit consent to continue while liveness is unknown. It
/// covers one attempt and is never stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnknownLiveness {
    NotConfirmed,
    Confirmed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "reason",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WriterRefusal {
    /// The session already has this managed writer; go to it instead.
    WriterActive { writer: Writer },
    /// A process outside Svode writes to the session.
    ExternalActive,
    /// Liveness is unknown and the user has not confirmed this attempt.
    ConfirmationRequired,
}

/// What a claim holds: a canonical session, or a launch whose canonical id
/// is not known yet.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum WriterTarget {
    Session(SessionKey),
    Launch(String),
}

/// The process-wide writer slots; clones share one registry.
#[derive(Clone, Default)]
pub struct WriterRegistry {
    slots: Arc<Mutex<Slots>>,
}

#[derive(Default)]
struct Slots {
    next: u64,
    held: HashMap<WriterTarget, Holder>,
}

#[derive(Clone, Copy)]
struct Holder {
    claim: u64,
    writer: Writer,
}

/// A held writer slot, released when dropped.
pub struct WriterClaim {
    slots: Arc<Mutex<Slots>>,
    id: u64,
    writer: Writer,
    target: WriterTarget,
}

impl WriterRegistry {
    /// Claims the session for `writer` before a start or continuation. A
    /// managed writer wins over any evidence; external evidence refuses
    /// both writers; unknown liveness needs the user's confirmation for an
    /// ACP continuation only — terminal resume runs the same native CLI the
    /// user would start by hand, with its own guards.
    pub fn claim(
        &self,
        key: &SessionKey,
        writer: Writer,
        liveness: ExternalLiveness,
        unknown: UnknownLiveness,
    ) -> Result<WriterClaim, WriterRefusal> {
        let mut slots = self.slots.lock().unwrap();
        let target = WriterTarget::Session(key.clone());
        if let Some(holder) = slots.held.get(&target) {
            return Err(WriterRefusal::WriterActive {
                writer: holder.writer,
            });
        }
        match (liveness, writer, unknown) {
            (ExternalLiveness::ExternalActive, _, _) => Err(WriterRefusal::ExternalActive),
            (ExternalLiveness::Unknown, Writer::Acp, UnknownLiveness::NotConfirmed) => {
                Err(WriterRefusal::ConfirmationRequired)
            }
            _ => Ok(self.hold(&mut slots, target, writer)),
        }
    }

    /// Claims a new launch before its process starts; the claim moves to
    /// the canonical session with [`WriterClaim::bind`].
    pub fn claim_launch(
        &self,
        launch_id: &str,
        writer: Writer,
    ) -> Result<WriterClaim, WriterRefusal> {
        let mut slots = self.slots.lock().unwrap();
        let target = WriterTarget::Launch(launch_id.to_string());
        if let Some(holder) = slots.held.get(&target) {
            return Err(WriterRefusal::WriterActive {
                writer: holder.writer,
            });
        }
        Ok(self.hold(&mut slots, target, writer))
    }

    /// The managed writer of the session, if any.
    pub fn writer(&self, key: &SessionKey) -> Option<Writer> {
        self.slots
            .lock()
            .unwrap()
            .held
            .get(&WriterTarget::Session(key.clone()))
            .map(|holder| holder.writer)
    }

    fn hold(&self, slots: &mut Slots, target: WriterTarget, writer: Writer) -> WriterClaim {
        slots.next += 1;
        let id = slots.next;
        slots
            .held
            .insert(target.clone(), Holder { claim: id, writer });
        WriterClaim {
            slots: self.slots.clone(),
            id,
            writer,
            target,
        }
    }
}

impl WriterClaim {
    pub fn writer(&self) -> Writer {
        self.writer
    }

    pub fn target(&self) -> &WriterTarget {
        &self.target
    }

    /// Moves a provisional launch claim to its canonical session once the
    /// id is known. The launch's own process is already the writer, so only
    /// another managed writer of that session refuses the move; the claim
    /// then stays on its launch.
    pub fn bind(&mut self, key: &SessionKey) -> Result<(), WriterRefusal> {
        let target = WriterTarget::Session(key.clone());
        if self.target == target {
            return Ok(());
        }
        let mut slots = self.slots.lock().unwrap();
        if let Some(holder) = slots.held.get(&target) {
            return Err(WriterRefusal::WriterActive {
                writer: holder.writer,
            });
        }
        slots.held.remove(&self.target);
        slots.held.insert(
            target.clone(),
            Holder {
                claim: self.id,
                writer: self.writer,
            },
        );
        self.target = target;
        Ok(())
    }
}

impl Drop for WriterClaim {
    fn drop(&mut self) {
        let mut slots = self.slots.lock().unwrap();
        if slots
            .held
            .get(&self.target)
            .is_some_and(|holder| holder.claim == self.id)
        {
            slots.held.remove(&self.target);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::IdentityNamespace;

    fn key(id: &str) -> SessionKey {
        SessionKey {
            agent: "codex".into(),
            namespace: IdentityNamespace::Native,
            session_id: id.into(),
        }
    }

    const UNCONFIRMED: UnknownLiveness = UnknownLiveness::NotConfirmed;

    #[test]
    fn a_session_never_gets_a_second_writer_in_either_direction() {
        let registry = WriterRegistry::default();
        let pty = registry
            .claim(
                &key("s1"),
                Writer::Pty,
                ExternalLiveness::Unknown,
                UNCONFIRMED,
            )
            .unwrap();
        assert_eq!(
            registry
                .claim(&key("s1"), Writer::Acp, ExternalLiveness::Free, UNCONFIRMED)
                .err(),
            Some(WriterRefusal::WriterActive {
                writer: Writer::Pty
            })
        );
        drop(pty);

        let _acp = registry
            .claim(&key("s1"), Writer::Acp, ExternalLiveness::Free, UNCONFIRMED)
            .unwrap();
        assert_eq!(registry.writer(&key("s1")), Some(Writer::Acp));
        assert_eq!(
            registry
                .claim(
                    &key("s1"),
                    Writer::Pty,
                    ExternalLiveness::Unknown,
                    UNCONFIRMED
                )
                .err(),
            Some(WriterRefusal::WriterActive {
                writer: Writer::Acp
            })
        );
        assert!(
            registry
                .claim(
                    &key("s2"),
                    Writer::Pty,
                    ExternalLiveness::Unknown,
                    UNCONFIRMED
                )
                .is_ok()
        );
    }

    #[test]
    fn external_evidence_refuses_both_writers() {
        let registry = WriterRegistry::default();
        for writer in [Writer::Acp, Writer::Pty] {
            assert_eq!(
                registry
                    .claim(
                        &key("s1"),
                        writer,
                        ExternalLiveness::ExternalActive,
                        UnknownLiveness::Confirmed
                    )
                    .err(),
                Some(WriterRefusal::ExternalActive)
            );
        }
        assert_eq!(registry.writer(&key("s1")), None);
    }

    #[test]
    fn unknown_liveness_needs_confirmation_for_acp_only_and_for_one_attempt() {
        let registry = WriterRegistry::default();
        assert_eq!(
            registry
                .claim(
                    &key("s1"),
                    Writer::Acp,
                    ExternalLiveness::Unknown,
                    UNCONFIRMED
                )
                .err(),
            Some(WriterRefusal::ConfirmationRequired)
        );
        let confirmed = registry
            .claim(
                &key("s1"),
                Writer::Acp,
                ExternalLiveness::Unknown,
                UnknownLiveness::Confirmed,
            )
            .unwrap();
        drop(confirmed);
        // The confirmation is not remembered.
        assert_eq!(
            registry
                .claim(
                    &key("s1"),
                    Writer::Acp,
                    ExternalLiveness::Unknown,
                    UNCONFIRMED
                )
                .err(),
            Some(WriterRefusal::ConfirmationRequired)
        );
        // Terminal resume keeps today's behaviour.
        assert!(
            registry
                .claim(
                    &key("s1"),
                    Writer::Pty,
                    ExternalLiveness::Unknown,
                    UNCONFIRMED
                )
                .is_ok()
        );
    }

    #[test]
    fn free_liveness_lets_acp_continue_without_confirmation() {
        let registry = WriterRegistry::default();
        assert!(
            registry
                .claim(&key("s1"), Writer::Acp, ExternalLiveness::Free, UNCONFIRMED)
                .is_ok()
        );
    }

    #[test]
    fn a_launch_claim_moves_to_its_canonical_session() {
        let registry = WriterRegistry::default();
        let mut launch = registry.claim_launch("launch-1", Writer::Pty).unwrap();
        assert!(registry.claim_launch("launch-1", Writer::Pty).is_err());
        launch.bind(&key("s1")).unwrap();
        assert_eq!(launch.target(), &WriterTarget::Session(key("s1")));
        assert_eq!(registry.writer(&key("s1")), Some(Writer::Pty));
        // The launch slot is free again and binding twice is a no-op.
        drop(registry.claim_launch("launch-1", Writer::Pty).unwrap());
        launch.bind(&key("s1")).unwrap();
        drop(launch);
        assert_eq!(registry.writer(&key("s1")), None);
    }

    #[test]
    fn a_launch_keeps_its_claim_when_the_session_has_another_writer() {
        let registry = WriterRegistry::default();
        let _acp = registry
            .claim(&key("s1"), Writer::Acp, ExternalLiveness::Free, UNCONFIRMED)
            .unwrap();
        let mut launch = registry.claim_launch("launch-1", Writer::Pty).unwrap();
        assert_eq!(
            launch.bind(&key("s1")),
            Err(WriterRefusal::WriterActive {
                writer: Writer::Acp
            })
        );
        assert_eq!(
            launch.target(),
            &WriterTarget::Launch("launch-1".to_string())
        );
        assert_eq!(registry.writer(&key("s1")), Some(Writer::Acp));
    }
}
