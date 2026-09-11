//! Variables domain shared by native consumers; no Tauri or S3 dependency.
pub mod files;
mod model;
mod service;

pub use model::*;
pub use service::*;

#[cfg(test)]
mod tests;
