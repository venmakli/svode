//! The release catalog of speech models (`catalog.json`): what a Svode
//! release lets the user install. It is compiled in and never read from the
//! network; a release replaces it.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

/// The languages dictation offers. A model lists those it transcribes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Language {
    Ru,
    En,
}

/// A recommendation by the E04 measurements (Stage 10 `06`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mark {
    /// The best mixed speech; slow without a GPU.
    Accurate,
    /// Nearly as accurate on plain Russian and English, fast on a CPU.
    Fast,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    /// A Hugging Face model repository.
    pub repo: String,
    /// The pinned commit of the repository.
    pub revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct License {
    pub name: String,
    pub link: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub id: String,
    pub name: String,
    pub family: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mark: Option<Mark>,
    /// The GGUF file name.
    pub file: String,
    pub quant: String,
    pub source: Source,
    /// Lowercase hex SHA-256 of the file.
    pub sha256: String,
    /// The file size in bytes.
    pub size: u64,
    /// The language tag the model takes for each language it transcribes.
    pub languages: BTreeMap<Language, String>,
    /// Whether the model detects the language itself ("Авто").
    pub detects_language: bool,
    pub license: License,
    /// The model the GGUF is converted from, for attribution.
    pub upstream: String,
}

impl CatalogModel {
    pub fn url(&self) -> String {
        format!(
            "https://huggingface.co/{}/resolve/{}/{}",
            self.source.repo, self.source.revision, self.file
        )
    }

    /// The tag to recognize `language` with; `None` (automatic detection)
    /// stays `None` for a model that detects the language and is its only
    /// language otherwise.
    pub fn language_tag(&self, language: Option<Language>) -> Option<&str> {
        match language {
            Some(language) => self.languages.get(&language).map(String::as_str),
            None if self.detects_language => None,
            None => self.languages.values().next().map(String::as_str),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    /// The engine release the catalog files are pinned for.
    pub engine: String,
    pub models: Vec<CatalogModel>,
}

static CATALOG: LazyLock<Catalog> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../catalog.json")).expect("catalog.json parses")
});

/// The catalog of this release.
pub fn catalog() -> &'static Catalog {
    &CATALOG
}

impl Catalog {
    pub fn get(&self, id: &str) -> Option<&CatalogModel> {
        self.models.iter().find(|model| model.id == id)
    }

    pub fn marked(&self, mark: Mark) -> &CatalogModel {
        self.models
            .iter()
            .find(|model| model.mark == Some(mark))
            .expect("the catalog marks an accurate and a fast model")
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn every_model_is_pinned_and_transcribes_russian_or_english() {
        let catalog = catalog();
        assert!(!catalog.models.is_empty());
        let mut ids = HashSet::new();
        for model in &catalog.models {
            assert!(ids.insert(&model.id), "{} is listed twice", model.id);
            assert!(!model.languages.is_empty(), "{}", model.id);
            assert_eq!(model.sha256.len(), 64, "{}", model.id);
            assert!(
                model
                    .sha256
                    .chars()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "{}",
                model.id
            );
            assert_eq!(model.source.revision.len(), 40, "{}", model.id);
            assert!(model.size > 0, "{}", model.id);
            assert!(model.url().starts_with("https://huggingface.co/"));
            assert!(model.license.link.is_some(), "{}", model.id);
        }
    }

    #[test]
    fn the_recommended_models_are_marked_once() {
        let catalog = catalog();
        assert_eq!(catalog.marked(Mark::Accurate).id, "whisper-large-v3-turbo");
        assert_eq!(catalog.marked(Mark::Fast).id, "parakeet-tdt-0.6b-v3");
        for mark in [Mark::Accurate, Mark::Fast] {
            let marked = catalog.models.iter().filter(|m| m.mark == Some(mark));
            assert_eq!(marked.count(), 1);
        }
    }

    #[test]
    fn a_language_maps_to_the_tag_the_model_takes() {
        let catalog = catalog();
        let turbo = catalog.marked(Mark::Accurate);
        assert_eq!(turbo.language_tag(Some(Language::Ru)), Some("ru"));
        assert_eq!(turbo.language_tag(None), None);

        let nemotron = catalog.get("nemotron-3.5-asr-streaming-0.6b").unwrap();
        assert_eq!(nemotron.language_tag(Some(Language::En)), Some("en-US"));

        // GigaAM transcribes Russian only and does not detect the language.
        let gigaam = catalog.get("gigaam-v3-e2e-rnnt").unwrap();
        assert!(!gigaam.languages.contains_key(&Language::En));
        assert_eq!(gigaam.language_tag(None), Some("ru"));
        assert_eq!(gigaam.language_tag(Some(Language::En)), None);
    }
}
