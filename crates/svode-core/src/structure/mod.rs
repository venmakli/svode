//! Structural operations over the content tree and the history they produce.

pub mod commit;
mod move_parent;
#[cfg(test)]
mod move_parent_tests;
pub mod naming;
pub mod ops;
pub mod plan;
#[cfg(test)]
mod portable_name_tests;
mod rename_target;
pub mod spaces;
#[cfg(test)]
mod tests;

pub use commit::{StructuralCommitSink, schedule_rename};
pub use naming::{
    abs_page_path, basename, grouped_abs_paths_by_space, order_path, page_commit_name, page_entity,
    page_history_commit_name, page_history_name, page_in_sensitive_collection,
    page_paths_with_order, page_relocation, page_rename_op, root_path_for_head,
};
pub use ops::{
    CollectionCreate, CollectionCreateOutcome, ConvertToCollectionOutcome, ConvertToLeafOutcome,
    ConvertedParent, DeleteOutcome, MovePageOutcome, StructureRuntime, convert_to_collection,
    convert_to_folder, convert_to_leaf, create_collection, create_folder, delete, duplicate,
    move_page, nest, rename, unnest,
};
pub use plan::{
    backlink_mutation_paths, collection_create_schema_paths, delete_mutation_paths,
    move_mutation_paths, move_page_mutation_paths, rename_mutation_paths,
};
pub use spaces::{ChildSpaceOrderOutcome, reorder_child_spaces};
