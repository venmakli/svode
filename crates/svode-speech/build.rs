//! Locates the engine's shared runtime for packaging and for running in place.
//!
//! On Windows and Linux x64 transcribe.cpp ships as a shared library plus
//! loadable ggml backend modules. Their directories reach only this crate, the
//! direct dependent of `transcribe-cpp`, so they are recorded in
//! `OUT_DIR/engine-runtime.json` for the Desktop sidecar build, which places
//! them next to the installed process. A static build (macOS) records nothing.

use std::env;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=DEP_TRANSCRIBE_CPP_RUNTIME_DIR");
    println!("cargo:rerun-if-env-changed=DEP_TRANSCRIBE_CPP_MODULE_DIR");
    println!("cargo:rerun-if-env-changed=DEP_TRANSCRIBE_CPP_LIB_DIR");

    let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    let manifest = out.join("engine-runtime.json");
    let runtime_dir = env::var("DEP_TRANSCRIBE_CPP_RUNTIME_DIR").ok();
    let module_dir = env::var("DEP_TRANSCRIBE_CPP_MODULE_DIR").ok();

    let Some(runtime_dir) = runtime_dir else {
        let _ = std::fs::remove_file(&manifest);
        return;
    };
    let json = serde_json::json!({ "runtimeDir": runtime_dir, "moduleDir": module_dir });
    std::fs::write(&manifest, json.to_string()).expect("write engine-runtime.json");

    // Linux has an rpath: the installed process finds the engine in the
    // app-private library directory of the package, and a process built in
    // place finds it in the build tree. Windows resolves DLLs from the
    // executable's own directory.
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib/Svode/speech");
        if let Ok(lib_dir) = env::var("DEP_TRANSCRIBE_CPP_LIB_DIR") {
            println!("cargo:rustc-link-arg=-Wl,-rpath,{lib_dir}");
        }
    }
}
