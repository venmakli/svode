//! What the host and the speech process exchange over the process's stdin and
//! stdout: one JSON object per line. A `Transcribe` request is followed by its
//! samples as little-endian `f32` bytes.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// The engine takes 16 kHz mono PCM in `[-1, 1]`.
pub const SAMPLE_RATE: u32 = 16_000;

/// The longest recording the process accepts. The composer stops a recording
/// at two minutes; this only bounds the memory a malformed request can claim.
pub const MAX_SAMPLES: usize = SAMPLE_RATE as usize * 600;

/// Whether the engine may use GPU acceleration for a model load.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Acceleration {
    /// The engine's own policy: a GPU when it finds one, the CPU otherwise.
    Auto,
    /// The CPU only.
    CpuOnly,
}

/// The compute backend a model ended up on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Backend {
    Cpu,
    Metal,
    Vulkan,
}

impl Backend {
    pub fn is_accelerated(self) -> bool {
        !matches!(self, Backend::Cpu)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Request {
    /// Load the model, replacing a loaded one.
    Load {
        model: PathBuf,
        acceleration: Acceleration,
    },
    /// Recognize the `samples` that follow this line. `language` is the
    /// tag the model takes (see the catalog); `None` is automatic detection.
    Transcribe {
        language: Option<String>,
        samples: usize,
    },
    /// Report the GPU the engine would accelerate with, without loading a
    /// model.
    Probe,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Response {
    Loaded {
        backend: Backend,
    },
    /// The accelerated backend of a GPU the engine found, if any.
    Probed {
        gpu: Option<Backend>,
    },
    Transcript {
        text: String,
    },
    Failed {
        error: ErrorCode,
    },
}

/// Why the engine refused a request. Codes only: an engine message may quote
/// the recognized text, which never leaves the process except as the result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    #[error("model file not found")]
    ModelMissing,
    #[error("model file is not a usable model")]
    ModelInvalid,
    #[error("out of memory")]
    OutOfMemory,
    #[error("compute backend failed")]
    Backend,
    #[error("audio is empty, too long or malformed")]
    AudioInvalid,
    #[error("the model does not support this request")]
    Unsupported,
    #[error("no model is loaded")]
    NotLoaded,
    #[error("malformed request")]
    Protocol,
    #[error("recognition failed")]
    Engine,
}

/// One protocol line, newline included.
pub fn line<T: Serialize>(message: &T) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(message).expect("protocol messages serialize");
    bytes.push(b'\n');
    bytes
}

pub fn encode_samples(samples: &[f32]) -> Vec<u8> {
    samples
        .iter()
        .flat_map(|sample| sample.to_le_bytes())
        .collect()
}

pub fn decode_samples(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_round_trip_as_tagged_lines() {
        let load = Request::Load {
            model: PathBuf::from("/models/whisper.gguf"),
            acceleration: Acceleration::CpuOnly,
        };
        let bytes = line(&load);
        assert_eq!(bytes.last(), Some(&b'\n'));
        let text = std::str::from_utf8(&bytes).unwrap();
        assert!(text.contains(r#""type":"load""#));
        assert!(text.contains(r#""acceleration":"cpuOnly""#));
        assert_eq!(serde_json::from_slice::<Request>(&bytes).unwrap(), load);

        let failed = Response::Failed {
            error: ErrorCode::ModelMissing,
        };
        assert_eq!(
            std::str::from_utf8(&line(&failed)).unwrap(),
            "{\"type\":\"failed\",\"error\":\"modelMissing\"}\n"
        );
    }

    #[test]
    fn samples_round_trip_as_little_endian_floats() {
        let samples = [0.0, -1.0, 0.5, f32::MIN_POSITIVE];
        let bytes = encode_samples(&samples);
        assert_eq!(bytes.len(), 16);
        assert_eq!(decode_samples(&bytes), samples);
    }
}
