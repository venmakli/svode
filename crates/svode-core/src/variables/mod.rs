//! Variables domain shared by native consumers; no Tauri or S3 dependency.
mod device;
pub mod files;
mod model;
mod service;

pub use device::*;
pub use model::*;
pub use service::*;

#[cfg(test)]
mod tests;
