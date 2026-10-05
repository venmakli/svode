//! Speech recognition for dictation, on the device.
//!
//! The engine runs in its own process (the `svode-speech` binary), so a ggml
//! abort cannot take the host down. This library holds what both sides share:
//! the [`protocol`] they speak and the [`client`] a host drives the process
//! with. A host depends on it without the `engine` feature.

pub mod client;
pub mod protocol;
