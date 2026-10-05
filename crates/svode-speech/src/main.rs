//! The Svode speech recognition process.
//!
//! A host starts it, loads a model and sends recordings; it answers with the
//! recognized text or an error code (see `svode_speech::protocol`). It keeps
//! audio and text in memory only, writes nothing to disk and logs nothing:
//! engine diagnostics are switched off, since a failure message may quote the
//! text. A ggml abort ends only this process; the host turns it into an error.
//! The process exits when its stdin closes.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::ExitCode;

use svode_speech::protocol::{
    self, Acceleration, Backend, ErrorCode, Language, MAX_SAMPLES, Request, Response,
};
use transcribe_cpp::{Model, ModelOptions, RunOptions, Session};

fn main() -> ExitCode {
    transcribe_cpp::disable_logging();
    // Loadable backend modules sit next to the engine library; a static
    // build has its backends compiled in and this is a no-op.
    let backends_ready = transcribe_cpp::init_backends_default().is_ok();

    let mut input = BufReader::new(io::stdin().lock());
    let mut output = io::stdout().lock();
    let mut engine = Engine::new(backends_ready);
    let mut header = String::new();
    loop {
        header.clear();
        match input.read_line(&mut header) {
            Ok(0) => return ExitCode::SUCCESS,
            Ok(_) => {}
            Err(_) => return ExitCode::FAILURE,
        }
        // After a malformed or oversized request the position of the next
        // line is unknown, so the process answers and exits.
        let (response, in_sync) = match serde_json::from_str::<Request>(&header) {
            Ok(Request::Load {
                model,
                acceleration,
            }) => (engine.load(&model, acceleration), true),
            Ok(Request::Transcribe { samples, .. }) if samples == 0 || samples > MAX_SAMPLES => {
                (failed(ErrorCode::AudioInvalid), false)
            }
            Ok(Request::Transcribe { language, samples }) => {
                let mut bytes = vec![0; samples * 4];
                if input.read_exact(&mut bytes).is_err() {
                    return ExitCode::FAILURE;
                }
                let samples = protocol::decode_samples(&bytes);
                (engine.transcribe(&samples, language), true)
            }
            Err(_) => (failed(ErrorCode::Protocol), false),
        };
        if output.write_all(&protocol::line(&response)).is_err() || output.flush().is_err() {
            return ExitCode::FAILURE;
        }
        if !in_sync {
            return ExitCode::FAILURE;
        }
    }
}

struct Engine {
    backends_ready: bool,
    loaded: Option<Loaded>,
}

struct Loaded {
    session: Session,
    acceleration: Acceleration,
}

impl Engine {
    fn new(backends_ready: bool) -> Self {
        Self {
            backends_ready,
            loaded: None,
        }
    }

    fn load(&mut self, path: &Path, acceleration: Acceleration) -> Response {
        self.loaded = None;
        if !self.backends_ready {
            return failed(ErrorCode::Backend);
        }
        let options = ModelOptions {
            backend: match acceleration {
                Acceleration::Auto => transcribe_cpp::Backend::Auto,
                Acceleration::CpuOnly => transcribe_cpp::Backend::Cpu,
            },
            device: None,
        };
        let model = match Model::load_with(path, &options) {
            Ok(model) => model,
            Err(error) => return failed(error_code(&error)),
        };
        // The device kind names the backend; `Model::backend` names the device.
        let kind = model.device().map(|device| device.kind).unwrap_or_default();
        let backend = match kind.as_str() {
            "metal" => Backend::Metal,
            "vulkan" => Backend::Vulkan,
            _ => Backend::Cpu,
        };
        let backend = fault::reported_backend(acceleration, backend);
        match model.session() {
            Ok(session) => {
                self.loaded = Some(Loaded {
                    session,
                    acceleration,
                });
                Response::Loaded { backend }
            }
            Err(error) => failed(error_code(&error)),
        }
    }

    fn transcribe(&mut self, samples: &[f32], language: Option<Language>) -> Response {
        let Some(loaded) = self.loaded.as_mut() else {
            return failed(ErrorCode::NotLoaded);
        };
        fault::before_transcribe(loaded.acceleration);
        let options = RunOptions {
            language: language.map(|language| language.code().to_string()),
            ..RunOptions::default()
        };
        match loaded.session.run(samples, &options) {
            Ok(transcript) => text(transcript.text),
            // The decode stopped early but kept what it recognized: the user
            // edits the draft anyway, so partial text beats an error.
            Err(
                transcribe_cpp::Error::OutputTruncated {
                    partial: Some(partial),
                    ..
                }
                | transcribe_cpp::Error::OutputRepetition {
                    partial: Some(partial),
                    ..
                },
            ) => text(partial.text),
            Err(error) => failed(error_code(&error)),
        }
    }
}

fn text(text: String) -> Response {
    Response::Transcript {
        text: text.trim().to_string(),
    }
}

fn failed(error: ErrorCode) -> Response {
    Response::Failed { error }
}

fn error_code(error: &transcribe_cpp::Error) -> ErrorCode {
    use transcribe_cpp::Error as E;
    match error {
        E::ModelFileNotFound(_) => ErrorCode::ModelMissing,
        E::ModelLoad(_) | E::BadStructSize(_) => ErrorCode::ModelInvalid,
        E::OutOfMemory(_) => ErrorCode::OutOfMemory,
        E::Backend(_) => ErrorCode::Backend,
        E::InvalidArgument(_) | E::InputTooLong(_) => ErrorCode::AudioInvalid,
        E::Unsupported(_) | E::NotImplemented(_) => ErrorCode::Unsupported,
        _ => ErrorCode::Engine,
    }
}

/// Failures the host's tests provoke in a debug build through
/// `SVODE_SPEECH_FAULT`: `crash` aborts on every recognition, `stall` never
/// answers one, and `crash-accelerated` claims a GPU for an `Auto` load and
/// aborts its recognitions, the way a failing GPU driver does. Release builds
/// ignore the variable.
mod fault {
    use svode_speech::protocol::{Acceleration, Backend};

    #[cfg(debug_assertions)]
    fn mode() -> Option<String> {
        std::env::var("SVODE_SPEECH_FAULT").ok()
    }

    #[cfg(not(debug_assertions))]
    fn mode() -> Option<String> {
        None
    }

    pub fn reported_backend(acceleration: Acceleration, backend: Backend) -> Backend {
        match (mode().as_deref(), acceleration) {
            (Some("crash-accelerated"), Acceleration::Auto) => Backend::Vulkan,
            _ => backend,
        }
    }

    pub fn before_transcribe(acceleration: Acceleration) {
        match (mode().as_deref(), acceleration) {
            (Some("crash"), _) | (Some("crash-accelerated"), Acceleration::Auto) => {
                std::process::abort()
            }
            (Some("stall"), _) => loop {
                std::thread::sleep(std::time::Duration::from_secs(3600));
            },
            _ => {}
        }
    }
}
