use super::{Error, Result, SourceOwner, SourceReference, valid_name};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppBindings {
    pub version: u32,
    pub legacy_normalized: bool,
    pub owners: BTreeMap<String, BTreeMap<String, SourceReference>>,
}

impl Default for AppBindings {
    fn default() -> Self {
        Self {
            version: 1,
            legacy_normalized: false,
            owners: BTreeMap::new(),
        }
    }
}

/// Pure normalization of the persisted registry snapshot; never scans owner directories.
pub fn normalize_app_bindings(
    registry: &Value,
    current: Option<AppBindings>,
) -> Result<AppBindings> {
    let mut result = current.unwrap_or(AppBindings {
        version: 1,
        ..Default::default()
    });
    if result.version != 1 {
        return Err(Error::UnsupportedVersion);
    }
    if result.legacy_normalized {
        return Ok(result);
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Usage {
        owner_directory: String,
        #[serde(default)]
        references: Vec<String>,
        #[serde(default)]
        bindings: BTreeMap<String, String>,
    }
    let apps: BTreeMap<String, Usage> = match registry.get("apps") {
        Some(apps) => serde_json::from_value(apps.clone()).map_err(|_| Error::InvalidConfig)?,
        None => BTreeMap::new(),
    };
    for (owner, usage) in apps {
        if !PathBuf::from(&usage.owner_directory).is_absolute() || owner != usage.owner_directory {
            return Err(Error::InvalidOwner);
        }
        let mappings = result.owners.entry(owner).or_default();
        for reference in usage.references.iter().chain(usage.bindings.keys()) {
            let name = usage.bindings.get(reference).unwrap_or(reference);
            if !valid_name(reference) || !valid_name(name) {
                return Err(Error::InvalidName);
            }
            mappings
                .entry(reference.clone())
                .or_insert_with(|| SourceReference {
                    owner: SourceOwner::Library,
                    name: name.clone(),
                });
        }
    }
    result.legacy_normalized = true;
    Ok(result)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretPair {
    pub access_key: SourceReference,
    pub secret_key: SourceReference,
}

#[derive(Debug, Clone)]
pub struct LegacyS3Input {
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub prefix: Option<String>,
    pub catalog_path: PathBuf,
    pub bindings: SecretPair,
}

/// The sole v1 input exception: typed library sources, never a credential blob.
pub fn normalize_s3_v1(input: &Value) -> Result<LegacyS3Input> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct V1 {
        version: u32,
        endpoint: String,
        bucket: String,
        region: String,
        prefix: Option<String>,
        catalog_path: PathBuf,
        bindings: Names,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Names {
        access_key: String,
        secret_key: String,
    }
    if input.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(Error::UnsupportedVersion);
    }
    let old: V1 = serde_json::from_value(input.clone()).map_err(|_| Error::InvalidConfig)?;
    if old.version != 1
        || !old.catalog_path.is_absolute()
        || old.endpoint.trim().is_empty()
        || old.bucket.trim().is_empty()
        || old.region.trim().is_empty()
        || !valid_name(&old.bindings.access_key)
        || !valid_name(&old.bindings.secret_key)
    {
        return Err(Error::InvalidConfig);
    }
    Ok(LegacyS3Input {
        endpoint: old.endpoint,
        bucket: old.bucket,
        region: old.region,
        prefix: old.prefix,
        catalog_path: old.catalog_path,
        bindings: SecretPair {
            access_key: SourceReference {
                owner: SourceOwner::Library,
                name: old.bindings.access_key,
            },
            secret_key: SourceReference {
                owner: SourceOwner::Library,
                name: old.bindings.secret_key,
            },
        },
    })
}
