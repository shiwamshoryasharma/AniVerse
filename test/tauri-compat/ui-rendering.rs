use super::*;

#[test]
fn rendering_preserves_inherited_webview_arguments_and_saves_only_supported_modes() {
    let args = OsStr::new("--remote-debugging-port=17832");
    let (active, appended) = browser_arguments(Mode::Stable, Some(args));
    assert!(active == Mode::Stable);
    assert_eq!(
        appended.unwrap(),
        "--remote-debugging-port=17832 --disable-gpu-compositing"
    );
    let (configured, appended) = browser_arguments(Mode::Accelerated, Some(args));
    assert!(configured == Mode::Accelerated && appended.is_none());
    let (forced, appended) = browser_arguments(
        Mode::Accelerated,
        Some(OsStr::new("\"--disable-gpu-compositing\"")),
    );
    assert!(forced == Mode::Stable && appended.is_none());

    let path = tempfile::tempdir_in(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/cache"))
        .unwrap();
    let service = Service {
        file: path.path().join("graphics.json"),
        active: Mode::Accelerated,
        preferred: Mutex::new(Mode::Accelerated),
    };
    assert!(service
        .set(json!({"mode":"stable","flags":"--unsafe"}))
        .is_err());
    assert_eq!(
        service.set(json!({"mode":"stable"})).unwrap(),
        json!({"active":"accelerated","preferred":"stable","restartRequired":true})
    );
    let contents = std::fs::read(&service.file).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&contents).unwrap(),
        json!({"mode":"stable"})
    );
}

#[test]
fn temporary_boot_arguments_restore_the_inherited_environment() {
    let root = tempfile::tempdir_in(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/cache"))
        .unwrap();
    let inherited = std::env::var_os(ARGUMENTS);
    std::fs::write(root.path().join("graphics.json"), r#"{"mode":"stable"}"#).unwrap();
    let (service, boot) = Service::startup(root.path());
    let applied = std::env::var_os(ARGUMENTS);
    drop(boot);
    assert_eq!(std::env::var_os(ARGUMENTS), inherited);
    assert!(applied.unwrap().to_string_lossy().contains(STABLE_SWITCH));
    assert_eq!(
        service.snapshot(),
        json!({"active":"stable","preferred":"stable","restartRequired":false})
    );
}
