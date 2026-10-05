//! Speech recognition for dictation, on the device.
//!
//! The engine runs in its own process (the `svode-speech` binary), so a ggml
//! abort cannot take the host down. This library holds what both sides share
//! and what a host needs around the process: the [`protocol`] they speak, the
//! [`client`] a host drives the process with, the release [`catalog`] of
//! models, the installed [`models`] and their [`preparation`] with the
//! recommendation for the device. A host depends on it without the `engine`
//! feature.

pub mod catalog;
pub mod client;
pub mod models;
pub mod preparation;
pub mod protocol;
