pub mod create;
pub mod dates;
pub mod entry;
mod error;
pub mod fields;
pub mod filename;
pub mod frontmatter;
pub mod identity;
pub mod indexed_dates;
pub mod links;
pub mod metadata;
pub mod naming;
pub mod nonce;
mod source;
mod target;
pub mod templates;
#[cfg(test)]
pub(crate) mod test_support;
pub mod write;

pub use error::PageError;

pub use target::{
    ResolvedSpaceTarget, SpaceReadiness, SpaceReference, read_standalone_page,
    registered_space_dirs, registered_spaces, resolve_space_target, space_reference_status,
};

pub use source::{
    ColorName, Cover, PageSource, PageSourceError, PageSourceMeta, PageSourceWarning,
    ParsedMarkdown, ResolvedPageTarget, SourceVersion, fallback_title, filesystem_dates,
    parse_markdown, read_page_source, resolve_page_target,
};
