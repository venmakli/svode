fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    // The debug tool dispatch can exceed the default 1 MiB Windows stack.
    let arg = if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        "/STACK:16777216"
    } else {
        "-Wl,--stack,16777216"
    };
    println!("cargo:rustc-link-arg-bin=svode-mcp={arg}");
}
