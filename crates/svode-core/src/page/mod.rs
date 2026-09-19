pub mod dates;
pub mod filename;
pub mod frontmatter;
pub mod identity;
pub mod links;
pub mod naming;
mod source;
mod target;

pub use target::{
    ResolvedSpaceTarget, SpaceReadiness, read_standalone_page, resolve_space_target,
    space_reference_status,
};

pub use source::{
    ColorName, Cover, PageSource, PageSourceError, PageSourceMeta, PageSourceWarning,
    ParsedMarkdown, ResolvedPageTarget, SourceVersion, fallback_title, filesystem_dates,
    parse_markdown, read_page_source, resolve_page_target,
};
