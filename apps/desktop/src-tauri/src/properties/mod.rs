//! Desktop adapter over the core Collections engine: index pool selection for
//! Collection reads, Entry hydration and the Actor catalog commands.

mod query;
pub use query::{list_entries_for_view, query_entries};

pub(crate) mod read;

#[cfg(test)]
mod tests;
