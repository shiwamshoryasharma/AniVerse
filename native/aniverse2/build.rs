use std::{env, fs, path::PathBuf};

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let renderer = env::var_os("ANIVERSE2_RENDERER_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("dist/aniverse2"));
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    println!("cargo:rerun-if-env-changed=ANIVERSE2_RENDERER_DIR");
    for name in [
        "settings-defaults.json",
        "changelog-versions.json",
        "anilist-home.graphql",
        "anilist-home-safe.graphql",
        "anilist-latest.graphql",
        "anilist-catalogue.json",
        "profile-migrations.json",
        "site-page.js",
        "site-focus.css",
        "site-upscale.js",
        "quantum-worklet.js",
        "quantum-audio.wasm",
        "site-audio.js",
        "site-catalogue.js",
        "chrome-player.js",
    ] {
        let source = renderer.join(name);
        println!("cargo:rerun-if-changed={}", source.display());
        fs::copy(source, out.join(name))
            .expect("build the AniVerse2 frontend before compiling the Tauri host");
    }
    let backup = renderer.join("backup-schema.json");
    println!("cargo:rerun-if-changed={}", backup.display());
    match fs::read(&backup) {
        Ok(schema) => fs::write(out.join("backup-schema.json"), schema),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::write(out.join("backup-schema.json"), "{}")
        }
        Err(error) => Err(error),
    }
    .expect("prepare portable Drive backup schema");
    let manifest = tauri_build::AppManifest::new().commands(&["desktop_rpc"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("configure AniVerse2");
}
