//! Git CLI handle of the shared core runtime. Delivery and command mapping
//! stay in the desktop adapters; detection and execution have one owner.

pub use svode_core::git::cli::{GitAvailability, GitCli, read_bounded};
