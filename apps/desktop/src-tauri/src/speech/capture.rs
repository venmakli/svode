//! Native microphone capture for dictation (V2 `06`): the default input
//! device of the default audio host on each OS, through cpal. The stream
//! lives on a thread of its own, because a cpal stream is not `Send` on
//! every host; its callback only downmixes and hands the samples over, and
//! the thread resamples them to 16 kHz, keeps them in memory and reports a
//! level per 50 ms window.
//!
//! Audio never reaches disk or logs; logs carry the host, the duration and
//! failure kinds only (V6).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{ErrorKind, FromSample, SampleFormat, SizedSample};
use serde::Serialize;
use svode_speech::protocol::SAMPLE_RATE;

use super::signal::{Meter, Resampler, downmix};

/// The composer stops a recording at two minutes; capture keeps a little
/// more so the stop request always finds the whole recording.
const MAX_SAMPLES: usize = SAMPLE_RATE as usize * 125;

/// `E_ACCESSDENIED` as cpal's WASAPI host reports it: an unclassified
/// backend error whose message is the `io::Error` of the HRESULT. Windows
/// returns it while "Let desktop apps access your microphone" is off.
const WINDOWS_ACCESS_DENIED: &str = "os error -2147024891";

/// Why capture could not start or delivered nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureFailure {
    /// The OS denies the app the microphone.
    Denied,
    /// No default input device, or no audio host to reach one.
    NoDevice,
    /// The device failed otherwise.
    Device,
}

impl CaptureFailure {
    pub fn code(self) -> &'static str {
        match self {
            Self::Denied => "denied",
            Self::NoDevice => "noDevice",
            Self::Device => "device",
        }
    }
}

/// Maps a cpal error of any host to what the user can do about it.
pub fn classify(kind: ErrorKind, message: Option<&str>) -> CaptureFailure {
    match kind {
        ErrorKind::PermissionDenied => CaptureFailure::Denied,
        ErrorKind::DeviceNotAvailable | ErrorKind::HostUnavailable => CaptureFailure::NoDevice,
        _ if message.is_some_and(|message| message.contains(WINDOWS_ACCESS_DENIED)) => {
            CaptureFailure::Denied
        }
        _ => CaptureFailure::Device,
    }
}

fn failure(error: &cpal::Error) -> CaptureFailure {
    classify(error.kind(), error.message())
}

/// A recording the user is making.
pub struct Capture {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<Recording>>,
}

/// What a finished capture holds.
pub struct Recording {
    /// 16 kHz mono.
    pub samples: Vec<f32>,
    pub has_signal: bool,
    /// The device failed while recording.
    pub failed: Option<CaptureFailure>,
}

impl Recording {
    pub fn duration(&self) -> Duration {
        Duration::from_secs_f64(self.samples.len() as f64 / f64::from(SAMPLE_RATE))
    }
}

impl Capture {
    /// Opens the default input device and starts recording; `level` gets
    /// the dBFS of each 50 ms window. Blocks until the stream plays.
    pub fn start(level: impl FnMut(f32) + Send + 'static) -> Result<Self, CaptureFailure> {
        let stop = Arc::new(AtomicBool::new(false));
        let (started, ready) = mpsc::channel();
        let thread_stop = stop.clone();
        let thread = std::thread::Builder::new()
            .name("speech-capture".to_string())
            .spawn(move || record(thread_stop, started, level))
            .map_err(|_| CaptureFailure::Device)?;
        match ready.recv() {
            Ok(Ok(())) => Ok(Self {
                stop,
                thread: Some(thread),
            }),
            Ok(Err(failure)) => {
                let _ = thread.join();
                Err(failure)
            }
            Err(_) => Err(CaptureFailure::Device),
        }
    }

    /// Stops recording and returns what was recorded.
    pub fn finish(mut self) -> Recording {
        self.stop.store(true, Ordering::SeqCst);
        self.thread
            .take()
            .and_then(|thread| thread.join().ok())
            .unwrap_or(Recording {
                samples: Vec::new(),
                has_signal: false,
                failed: Some(CaptureFailure::Device),
            })
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

fn record(
    stop: Arc<AtomicBool>,
    started: mpsc::Sender<Result<(), CaptureFailure>>,
    mut level: impl FnMut(f32),
) -> Recording {
    let empty = |failed| Recording {
        samples: Vec::new(),
        has_signal: false,
        failed,
    };
    let (chunks, received) = mpsc::channel::<Vec<f32>>();
    let stream_failure = Arc::new(Mutex::new(None));
    let (stream, rate) = match open(chunks, stream_failure.clone()) {
        Ok(opened) => opened,
        Err(failure) => {
            let _ = started.send(Err(failure));
            return empty(Some(failure));
        }
    };
    let _ = started.send(Ok(()));

    let mut resampler = Resampler::new(rate);
    let mut meter = Meter::default();
    let mut samples = Vec::with_capacity(SAMPLE_RATE as usize * 30);
    let mut take = |chunk: Vec<f32>, samples: &mut Vec<f32>| {
        if samples.len() >= MAX_SAMPLES {
            return;
        }
        let from = samples.len();
        resampler.push(&chunk, samples);
        samples.truncate(MAX_SAMPLES);
        meter.push(&samples[from..], &mut level);
    };
    while !stop.load(Ordering::SeqCst) {
        if let Ok(chunk) = received.recv_timeout(Duration::from_millis(20)) {
            take(chunk, &mut samples);
        }
    }
    drop(stream);
    while let Ok(chunk) = received.try_recv() {
        take(chunk, &mut samples);
    }
    let failed = *stream_failure.lock().expect("capture failure lock");
    Recording {
        has_signal: meter.has_signal(),
        samples,
        failed,
    }
}

fn open(
    chunks: mpsc::Sender<Vec<f32>>,
    failure_slot: Arc<Mutex<Option<CaptureFailure>>>,
) -> Result<(cpal::Stream, u32), CaptureFailure> {
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or_else(|| {
        tracing::warn!(
            host = host.id().name(),
            "dictation: no default input device"
        );
        CaptureFailure::NoDevice
    })?;
    let config = device.default_input_config().map_err(|error| {
        let failure = failure(&error);
        tracing::warn!(
            host = host.id().name(),
            failure = failure.code(),
            "dictation: no input config"
        );
        failure
    })?;
    let rate = config.sample_rate();
    let channels = usize::from(config.channels());
    let format = config.sample_format();
    let config: cpal::StreamConfig = config.into();
    let stream = match format {
        SampleFormat::F32 => build::<f32>(&device, config, channels, chunks, failure_slot),
        SampleFormat::I16 => build::<i16>(&device, config, channels, chunks, failure_slot),
        SampleFormat::I32 => build::<i32>(&device, config, channels, chunks, failure_slot),
        SampleFormat::U16 => build::<u16>(&device, config, channels, chunks, failure_slot),
        SampleFormat::I8 => build::<i8>(&device, config, channels, chunks, failure_slot),
        SampleFormat::U8 => build::<u8>(&device, config, channels, chunks, failure_slot),
        SampleFormat::F64 => build::<f64>(&device, config, channels, chunks, failure_slot),
        other => {
            tracing::warn!(host = host.id().name(), format = ?other, "dictation: unsupported sample format");
            return Err(CaptureFailure::Device);
        }
    }
    .and_then(|stream| stream.play().map(|()| stream))
    .map_err(|error| {
        let failure = failure(&error);
        tracing::warn!(host = host.id().name(), failure = failure.code(), "dictation: capture did not start");
        failure
    })?;
    tracing::info!(
        host = host.id().name(),
        rate,
        channels,
        "dictation: capture started"
    );
    Ok((stream, rate))
}

fn build<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    channels: usize,
    chunks: mpsc::Sender<Vec<f32>>,
    failure_slot: Arc<Mutex<Option<CaptureFailure>>>,
) -> Result<cpal::Stream, cpal::Error>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    device.build_input_stream::<T, _, _>(
        config,
        move |data: &[T], _| {
            let samples: Vec<f32> = data
                .iter()
                .map(|sample| sample.to_sample::<f32>())
                .collect();
            let _ = chunks.send(downmix(&samples, channels));
        },
        move |error| match error.kind() {
            // Not failures of the recording.
            ErrorKind::DeviceChanged | ErrorKind::Xrun | ErrorKind::RealtimeDenied => {}
            _ => {
                let failure = failure(&error);
                tracing::warn!(failure = failure.code(), "dictation: input stream failed");
                *failure_slot.lock().expect("capture failure lock") = Some(failure);
            }
        },
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_denial_of_each_os_is_the_denied_state() {
        // macOS (CoreAudio `Unauthorized`), Linux (ALSA `EACCES`,
        // PulseAudio `AccessDenied`) — cpal's own kind.
        assert_eq!(
            classify(ErrorKind::PermissionDenied, Some("Permission denied")),
            CaptureFailure::Denied
        );
        // Windows: WASAPI `E_ACCESSDENIED` arrives as an unclassified
        // backend error, its message localized except for the code.
        assert_eq!(
            classify(
                ErrorKind::BackendError,
                Some("Отказано в доступе. (os error -2147024891)")
            ),
            CaptureFailure::Denied
        );
    }

    #[test]
    fn a_missing_device_or_audio_host_is_no_device() {
        assert_eq!(
            classify(ErrorKind::DeviceNotAvailable, None),
            CaptureFailure::NoDevice
        );
        // Linux without a running audio server.
        assert_eq!(
            classify(ErrorKind::HostUnavailable, Some("connection refused")),
            CaptureFailure::NoDevice
        );
    }

    #[test]
    fn other_failures_are_device_failures() {
        for kind in [
            ErrorKind::DeviceBusy,
            ErrorKind::UnsupportedConfig,
            ErrorKind::BackendError,
            ErrorKind::Other,
        ] {
            assert_eq!(
                classify(kind, Some("The device is in use. (os error -2004287478)")),
                CaptureFailure::Device,
                "{kind:?}"
            );
        }
    }
}
