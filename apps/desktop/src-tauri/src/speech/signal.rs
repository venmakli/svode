//! What a dictation recording becomes on its way to the speech process:
//! mono, resampled to the 16 kHz the engine takes, measured in 50 ms
//! windows for the level wave and for "no signal" (V2 `06`).

use svode_speech::protocol::SAMPLE_RATE;

/// One level window: 50 ms at 16 kHz, also the rate of the level wave.
pub const WINDOW: usize = SAMPLE_RATE as usize / 20;

/// A recording whose loudest window stays below this level has no signal.
/// The quiet speech of E04 averaged −43 dBFS, its pauses included, so even
/// its softest words sit well above; a muted input or a device that
/// delivers digital silence stays far below.
pub const NO_SIGNAL_DBFS: f32 = -70.0;

/// The floor of a level, for a window of exact zeros.
pub const SILENCE_DBFS: f32 = -100.0;

/// Averages interleaved frames of `channels` into mono.
pub fn downmix(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

/// Resamples a stream by averaging the input over the span of each output
/// sample. The average is the low-pass that keeps a higher input rate from
/// aliasing into speech; it holds for any ratio, including the 44.1 kHz of
/// many devices.
pub struct Resampler {
    /// Input samples per output sample.
    step: f64,
    /// The weighted sum of the output sample in progress.
    sum: f64,
    /// How much input it has taken so far.
    filled: f64,
}

impl Resampler {
    pub fn new(input_rate: u32) -> Self {
        Self {
            step: f64::from(input_rate) / f64::from(SAMPLE_RATE),
            sum: 0.0,
            filled: 0.0,
        }
    }

    pub fn push(&mut self, input: &[f32], output: &mut Vec<f32>) {
        for &sample in input {
            let mut left = 1.0;
            while left > 0.0 {
                let room = self.step - self.filled;
                if left < room {
                    self.sum += f64::from(sample) * left;
                    self.filled += left;
                    left = 0.0;
                } else {
                    self.sum += f64::from(sample) * room;
                    output.push((self.sum / self.step) as f32);
                    self.sum = 0.0;
                    self.filled = 0.0;
                    left -= room;
                }
            }
        }
    }
}

/// The level of `samples` in dBFS: the RMS, floored at [`SILENCE_DBFS`].
pub fn level(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return SILENCE_DBFS;
    }
    let power = samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32;
    (10.0 * power.max(1e-10).log10()).max(SILENCE_DBFS)
}

/// Measures 16 kHz mono samples in [`WINDOW`]s as they arrive and remembers
/// the loudest one.
pub struct Meter {
    pending: Vec<f32>,
    loudest: f32,
}

impl Default for Meter {
    fn default() -> Self {
        Self {
            pending: Vec::with_capacity(WINDOW),
            loudest: SILENCE_DBFS,
        }
    }
}

impl Meter {
    /// Takes `samples` and calls `window` with the level of each window they
    /// complete.
    pub fn push(&mut self, samples: &[f32], mut window: impl FnMut(f32)) {
        for &sample in samples {
            self.pending.push(sample);
            if self.pending.len() == WINDOW {
                let level = level(&self.pending);
                self.loudest = self.loudest.max(level);
                self.pending.clear();
                window(level);
            }
        }
    }

    /// Whether any part of the recording reached [`NO_SIGNAL_DBFS`],
    /// counting a last partial window.
    pub fn has_signal(&self) -> bool {
        self.loudest.max(level(&self.pending)) >= NO_SIGNAL_DBFS
    }
}

#[cfg(test)]
mod tests {
    use std::f32::consts::TAU;

    use super::*;

    fn tone(rate: u32, seconds: f32, frequency: f32, dbfs: f32) -> Vec<f32> {
        // The RMS of a sine is its peak over √2.
        let amplitude = 10f32.powf(dbfs / 20.0) * std::f32::consts::SQRT_2;
        (0..(rate as f32 * seconds) as usize)
            .map(|n| amplitude * (TAU * frequency * n as f32 / rate as f32).sin())
            .collect()
    }

    fn measure(samples: &[f32]) -> Meter {
        let mut meter = Meter::default();
        meter.push(samples, |_| {});
        meter
    }

    #[test]
    fn downmix_averages_the_channels_of_each_frame() {
        assert_eq!(downmix(&[0.5, -0.5, 1.0, 0.0], 2), vec![0.0, 0.5]);
        assert_eq!(downmix(&[0.25, 0.5], 1), vec![0.25, 0.5]);
    }

    #[test]
    fn resampling_keeps_the_length_and_level_of_speech_band_audio() {
        for rate in [48_000, 44_100, 16_000, 8_000] {
            let input = tone(rate, 1.0, 300.0, -20.0);
            let mut resampler = Resampler::new(rate);
            let mut output = Vec::new();
            // Callbacks deliver uneven chunks.
            for chunk in input.chunks(441) {
                resampler.push(chunk, &mut output);
            }
            let expected = SAMPLE_RATE as usize;
            assert!(
                output.len().abs_diff(expected) <= 1,
                "{rate}: {}",
                output.len()
            );
            let db = level(&output[WINDOW..]);
            assert!((db + 20.0).abs() < 0.5, "{rate}: {db}");
        }
    }

    #[test]
    fn resampling_attenuates_what_lies_above_the_engine_band() {
        // 15 kHz would alias to 1 kHz; averaging over three input samples
        // keeps little of it.
        let input = tone(48_000, 0.5, 15_000.0, -20.0);
        let mut output = Vec::new();
        Resampler::new(48_000).push(&input, &mut output);
        assert!(level(&output) < -35.0, "{}", level(&output));
    }

    #[test]
    fn a_silent_or_muted_recording_has_no_signal() {
        assert!(!measure(&vec![0.0; SAMPLE_RATE as usize * 3]).has_signal());
        // Noise floor of a muted input.
        assert!(!measure(&tone(SAMPLE_RATE, 3.0, 1_000.0, -85.0)).has_signal());
        assert!(!measure(&[]).has_signal());
    }

    #[test]
    fn quiet_speech_has_signal() {
        // Words at −40 dBFS between pauses of silence average about −43
        // dBFS, as the quiet recording of E04.
        let mut quiet = Vec::new();
        for _ in 0..4 {
            quiet.extend(tone(SAMPLE_RATE, 0.5, 220.0, -40.0));
            quiet.extend(vec![0.0; SAMPLE_RATE as usize / 2]);
        }
        let average = level(&quiet);
        assert!((-44.0..-42.0).contains(&average), "{average}");
        assert!(measure(&quiet).has_signal());
        // A single soft word near the threshold still counts.
        let mut soft = vec![0.0; SAMPLE_RATE as usize];
        soft.extend(tone(SAMPLE_RATE, 0.2, 220.0, -65.0));
        assert!(measure(&soft).has_signal());
    }

    #[test]
    fn the_meter_reports_a_level_for_every_window() {
        let mut levels = Vec::new();
        Meter::default().push(&tone(SAMPLE_RATE, 1.0, 220.0, -30.0), |db| levels.push(db));
        assert_eq!(levels.len(), 20);
        assert!(
            levels.iter().all(|db| (db + 30.0).abs() < 0.5),
            "{levels:?}"
        );
    }
}
