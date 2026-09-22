//! Structural operations over the content tree and the history they produce.

pub mod commit;
pub mod naming;
pub mod ops;
pub mod plan;
pub mod spaces;
#[cfg(test)]
mod tests;

pub use commit::StructuralCommitSink;
pub use naming::{
    abs_entry_path, basename, entry_commit_name, entry_history_commit_name, entry_history_name,
    entry_in_sensitive_collection, entry_paths_with_order, entry_rename_op,
    grouped_abs_paths_by_space, order_path, root_path_for_head,
};
pub use ops::{
    CollectionCreate, CollectionCreateOutcome, ConvertToCollectionOutcome, DeleteOutcome,
    StructureRuntime, convert_to_collection, convert_to_folder, convert_to_leaf, create_collection,
    create_folder, delete, duplicate, move_entry, nest, rename, unnest,
};
pub use plan::{
    backlink_mutation_paths, collection_create_schema_paths, delete_mutation_paths,
    move_mutation_paths,
};
pub use spaces::{ChildSpaceOrderOutcome, reorder_child_spaces};
