/// Stack reserve of the main thread of the Windows binary. Windows links a 1 MiB
/// default, and an IPC call runs `tauri::generate_handler!` with every command
/// future on the main thread, which overflowed it on opening a project
/// (tauri-apps/tauri#14167). macOS and Linux give the main thread 8 MiB; the
/// reserve is address space, committed only as the stack grows.
const WINDOWS_MAIN_STACK_BYTES: u64 = 16 * 1024 * 1024;

fn main() {
    reserve_windows_main_stack();
    tauri_build::build()
}

fn reserve_windows_main_stack() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let arg = if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        format!("/STACK:{WINDOWS_MAIN_STACK_BYTES}")
    } else {
        format!("-Wl,--stack,{WINDOWS_MAIN_STACK_BYTES}")
    };
    println!("cargo:rustc-link-arg-bin=svode-desktop={arg}");
}
