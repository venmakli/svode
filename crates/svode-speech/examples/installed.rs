//! Checks the speech process of an installed Svode package, as CI does with
//! the NSIS and `.deb` installers on runners without a GPU (Stage 10 `06`).
//!
//! ```text
//! installed <svode-speech of the installed package> <whisper-tiny model file>
//! ```
//!
//! Installs the compact catalog model from the local file through the model
//! store, which checks its size and SHA-256 against the catalog, prepares it
//! with the installed process the way Svode does after an install, and
//! recognizes the reference recording. `SVODE_SPEECH_EXPECT_BACKEND` (`cpu`,
//! `metal` or `vulkan`) pins the backend the engine must pick on its own.
//!
//! It drives the process through the host library only, so it builds
//! without the engine: `cargo build -p svode-speech --no-default-features
//! --example installed`.

use std::path::PathBuf;
use std::process::ExitCode;

use svode_speech::catalog::catalog;
use svode_speech::client::{Recognizer, RecognizerConfig};
use svode_speech::models::ModelStore;
use svode_speech::preparation::{prepare, reference};
use tokio::io::AsyncReadExt;

const MODEL: &str = "whisper-tiny";
const PHRASE: &str = "ask not what your country can do for you";

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1).map(PathBuf::from);
    let (Some(program), Some(source)) = (args.next(), args.next()) else {
        eprintln!("usage: installed <svode-speech> <{MODEL} model file>");
        return ExitCode::FAILURE;
    };
    match check(program, source).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("installed speech check failed: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn check(program: PathBuf, source: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let data = tempfile::tempdir()?;
    let store = ModelStore::open(data.path().join("speech"));
    let entry = catalog()
        .get(MODEL)
        .ok_or("the catalog has no compact model")?;

    let mut install = store.begin_install(entry)?;
    let mut file = tokio::fs::File::open(&source).await?;
    let mut chunk = vec![0; 1 << 20];
    loop {
        let read = file.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        install.write(&chunk[..read]).await?;
    }
    let installed = install.finish().await?;
    if store.active(catalog()).as_ref() != Some(&installed) {
        return Err("the installed model is not the active one".into());
    }
    let model = store.model_path(&installed);
    println!(
        "installed {} ({} bytes, SHA-256 checked)",
        entry.id, installed.size
    );

    let recognizer = Recognizer::new(RecognizerConfig::new(
        program,
        data.path().join("speech/engine.json"),
        env!("CARGO_PKG_VERSION"),
    ));
    let gpu = recognizer.probe().await?;
    println!("probed GPU: {gpu:?}");

    let measurement = prepare(&recognizer, entry, &model).await?;
    store.record_measurement(&installed.id, measurement.clone())?;
    println!(
        "prepared on {:?}: reference recording in {:.2} s",
        measurement.backend, measurement.seconds
    );

    let language = entry.language_tag(entry.language(store.settings().language));
    let transcription = recognizer.transcribe(&model, reference(), language).await;
    recognizer.shutdown().await;
    let transcription = transcription?;
    println!(
        "recognized on {:?} in {:.2} s",
        transcription.backend,
        transcription.elapsed.as_secs_f64()
    );

    if let Ok(expected) = std::env::var("SVODE_SPEECH_EXPECT_BACKEND") {
        for (stage, backend) in [
            (
                "probe",
                gpu.map_or("cpu".to_string(), |gpu| format!("{gpu:?}")),
            ),
            ("preparation", format!("{:?}", measurement.backend)),
            ("recognition", format!("{:?}", transcription.backend)),
        ] {
            if !backend.eq_ignore_ascii_case(&expected) {
                return Err(format!("{stage} used {backend}, expected {expected}").into());
            }
        }
    }
    if !normalized(&transcription.text).contains(PHRASE) {
        return Err(format!("unexpected transcript: {:?}", transcription.text).into());
    }
    Ok(())
}

fn normalized(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
