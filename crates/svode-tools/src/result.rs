//! Result of one tool call: text content for the caller plus the structured
//! result or business error of the operation.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::ToolError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentBlock {
    #[serde(rename = "type")]
    pub kind: String,
    pub text: String,
}

impl ContentBlock {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            kind: "text".to_string(),
            text: text.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallResult {
    pub content: Vec<ContentBlock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structured_content: Option<Value>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_error: bool,
}

impl ToolCallResult {
    pub fn ok(text: impl Into<String>, structured: Value) -> Self {
        Self {
            content: vec![ContentBlock::text(text)],
            structured_content: Some(structured),
            is_error: false,
        }
    }

    pub fn business_error(error: ToolError) -> Self {
        Self {
            content: vec![ContentBlock::text(error.message.clone())],
            structured_content: Some(serde_json::json!({
                "error": {
                    "code": error.code,
                    "message": error.message,
                }
            })),
            is_error: true,
        }
    }
}
