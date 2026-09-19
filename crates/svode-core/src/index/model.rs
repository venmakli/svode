#[derive(Debug, Clone)]
pub struct KnowledgeArtifact {
    pub source_path: String,
    pub kind: String,
    pub title: String,
    pub content_hash: String,
    pub source_updated_at: String,
    pub checked_at: String,
    pub canonical_source_path: String,
    pub provenance_json: String,
    pub fragments: Vec<KnowledgeFragmentArtifact>,
    pub edges: Vec<KnowledgeEdgeArtifact>,
}

#[derive(Debug, Clone)]
pub struct KnowledgeFragmentArtifact {
    pub text: String,
    pub location_path: String,
    pub line_start: i64,
    pub line_end: i64,
    pub byte_start: i64,
    pub byte_end: i64,
}

#[derive(Debug, Clone)]
pub struct KnowledgeEdgeArtifact {
    pub kind: String,
    pub target_url: String,
    pub target_scope: String,
    pub target_path: Option<String>,
    pub target_kind: Option<String>,
    pub field_name: Option<String>,
    pub location_path: String,
    pub byte_start: i64,
    pub byte_end: i64,
}

pub struct IndexedEntry {
    pub rel_path: String,
    pub parent_path: String,
    pub title: String,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub cover_json: Option<String>,
    pub created: String,
    pub updated: String,
    pub collection_root_path: Option<String>,
    pub in_collection: bool,
    pub is_entry_head: bool,
    pub fields_json: String,
    pub body_preview: String,
    pub is_discoverable: bool,
    pub knowledge: Option<KnowledgeArtifact>,
    pub source_diagnostic: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeAgentApplicability {
    pub source_scope: String,
    pub source_path: String,
    pub node_kind: String,
    pub provenance: serde_json::Value,
}
