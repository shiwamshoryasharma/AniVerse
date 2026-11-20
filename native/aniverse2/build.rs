use std::{env, fs, path::PathBuf};

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let renderer = env::var_os("ANIVERSE2_RENDERER_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("dist/aniverse2"));
    let defaults = renderer.join("settings-defaults.json");
    println!("cargo:rerun-if-env-changed=ANIVERSE2_RENDERER_DIR");
    println!("cargo:rerun-if-changed={}", defaults.display());
    fs::copy(
        &defaults,
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("settings-defaults.json"),
    )
    .expect("build the AniVerse2 frontend before compiling the Tauri host");
    let manifest = tauri_build::AppManifest::new().commands(&["desktop_rpc"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("configure AniVerse2");
}
