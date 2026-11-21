fn main() {
    let manifest = tauri_build::AppManifest::new().commands(&["probe_config", "record_probe"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("build compatibility probe");
}
