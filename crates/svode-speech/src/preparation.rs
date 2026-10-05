//! "Подготовка модели" after an install or update: warm the engine up and
//! measure how long the model takes to recognize the reference recording
//! shipped with Svode (V7 `06`). The user's own audio is never involved.

use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

use serde::Serialize;

use crate::catalog::{CatalogModel, Mark};
use crate::client::{Recognizer, RecognizerError};
use crate::models::Measurement;
use crate::protocol::{Backend, SAMPLE_RATE};

/// The accurate model stays the recommendation when it recognizes the
/// reference recording within this time (criterion 1 of `06`).
pub const ACCURATE_LIMIT: Duration = Duration::from_secs(3);

/// The warm-up recognizes the beginning of the reference recording: a GPU
/// backend may compile its kernels on the first run rather than on load.
const WARM_UP: Duration = Duration::from_secs(2);

static REFERENCE: LazyLock<Vec<f32>> = LazyLock::new(|| {
    let bytes: &[u8] = include_bytes!("../assets/reference.wav");
    let reader = hound::WavReader::new(bytes).expect("reference.wav is a WAV file");
    let spec = reader.spec();
    assert_eq!(
        (spec.sample_rate, spec.channels, spec.bits_per_sample),
        (SAMPLE_RATE, 1, 16)
    );
    reader
        .into_samples::<i16>()
        .map(|sample| sample.expect("reference.wav decodes") as f32 / 32_768.0)
        .collect()
});

/// The reference recording: 11 s of 16 kHz mono speech in the public domain
/// (see `assets/README.md`).
pub fn reference() -> &'static [f32] {
    &REFERENCE
}

/// Loads `model` (the first load after an update compiles the GPU shaders),
/// warms it up and measures the reference recording. A GPU that fails
/// meanwhile is refused as during a recognition (V3), and the preparation
/// runs again on the CPU.
pub async fn prepare(
    recognizer: &Recognizer,
    model: &CatalogModel,
    path: &Path,
) -> Result<Measurement, RecognizerError> {
    let refused = recognizer.acceleration_refused();
    match measure(recognizer, model, path).await {
        Err(_) if !refused && recognizer.acceleration_refused() => {
            measure(recognizer, model, path).await
        }
        result => result,
    }
}

async fn measure(
    recognizer: &Recognizer,
    model: &CatalogModel,
    path: &Path,
) -> Result<Measurement, RecognizerError> {
    let language = model.language_tag(None);
    recognizer.load(path).await?;
    let warm_up = (WARM_UP.as_secs() as usize * SAMPLE_RATE as usize).min(reference().len());
    recognizer
        .transcribe(path, &reference()[..warm_up], language)
        .await?;
    let measured = recognizer.transcribe(path, reference(), language).await?;
    let measurement = Measurement {
        seconds: measured.elapsed.as_secs_f64(),
        backend: measured.backend,
        version: recognizer.build_version().to_string(),
    };
    tracing::info!(
        model = %model.id,
        backend = ?measurement.backend,
        measured_ms = measured.elapsed.as_millis() as u64,
        "speech model prepared"
    );
    Ok(measurement)
}

/// Which marked model V7 recommends for this device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recommendation {
    pub model: Mark,
    /// Whether it rests on a current measurement of the accurate model
    /// rather than on the acceleration found.
    pub measured: bool,
    /// The accurate model was measured slower than [`ACCURATE_LIMIT`].
    pub accurate_slow: bool,
}

/// V7: before a current measurement of the accurate model, the accurate
/// model when the engine found a GPU it may use, the fast one otherwise;
/// after it, the accurate model within [`ACCURATE_LIMIT`], the fast one
/// otherwise. It is shown only and never changes the chosen model.
pub fn recommend(
    gpu: Option<Backend>,
    acceleration_refused: bool,
    accurate: Option<&Measurement>,
    version: &str,
) -> Recommendation {
    match accurate.filter(|m| m.is_current(version, acceleration_refused)) {
        Some(measurement) => {
            let slow = measurement.seconds > ACCURATE_LIMIT.as_secs_f64();
            Recommendation {
                model: if slow { Mark::Fast } else { Mark::Accurate },
                measured: true,
                accurate_slow: slow,
            }
        }
        None => Recommendation {
            model: if gpu.is_some() && !acceleration_refused {
                Mark::Accurate
            } else {
                Mark::Fast
            },
            measured: false,
            accurate_slow: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn measured(seconds: f64, backend: Backend, version: &str) -> Measurement {
        Measurement {
            seconds,
            backend,
            version: version.to_string(),
        }
    }

    #[test]
    fn the_reference_recording_is_about_ten_seconds() {
        let seconds = reference().len() as f64 / SAMPLE_RATE as f64;
        assert!((9.0..=12.0).contains(&seconds), "{seconds}");
    }

    #[test]
    fn before_a_measurement_the_acceleration_found_decides() {
        let gpu = recommend(Some(Backend::Metal), false, None, "1");
        assert_eq!(gpu.model, Mark::Accurate);
        assert!(!gpu.measured);
        assert_eq!(
            recommend(Some(Backend::Vulkan), false, None, "1").model,
            Mark::Accurate
        );
        assert_eq!(recommend(None, false, None, "1").model, Mark::Fast);
        // A device that refused acceleration recommends for the CPU.
        assert_eq!(
            recommend(Some(Backend::Vulkan), true, None, "1").model,
            Mark::Fast
        );
    }

    #[test]
    fn after_a_measurement_the_three_second_limit_decides() {
        let fast_enough = measured(2.7, Backend::Metal, "1");
        let accurate = recommend(Some(Backend::Metal), false, Some(&fast_enough), "1");
        assert_eq!(accurate.model, Mark::Accurate);
        assert!(accurate.measured && !accurate.accurate_slow);

        // A slow integrated GPU found acceleration but measured slow.
        let slow = measured(4.2, Backend::Vulkan, "1");
        let fast = recommend(Some(Backend::Vulkan), false, Some(&slow), "1");
        assert_eq!(fast.model, Mark::Fast);
        assert!(fast.measured && fast.accurate_slow);

        // A CPU that measured within the limit keeps the accurate model.
        let cpu = measured(2.9, Backend::Cpu, "1");
        assert_eq!(
            recommend(None, false, Some(&cpu), "1").model,
            Mark::Accurate
        );
    }

    #[test]
    fn an_update_or_a_refused_gpu_outdates_the_measurement() {
        let gpu = measured(2.0, Backend::Metal, "1");
        let updated = recommend(Some(Backend::Metal), false, Some(&gpu), "2");
        assert!(!updated.measured);
        assert_eq!(updated.model, Mark::Accurate);

        let refused = recommend(Some(Backend::Metal), true, Some(&gpu), "1");
        assert!(!refused.measured);
        assert_eq!(refused.model, Mark::Fast);

        // A CPU measurement survives the refusal of acceleration.
        let cpu = measured(5.0, Backend::Cpu, "1");
        let still = recommend(None, true, Some(&cpu), "1");
        assert!(still.measured && still.accurate_slow);
    }
}
