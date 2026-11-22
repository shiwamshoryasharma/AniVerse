use super::*;

#[test]
fn rendering_keeps_wry_defaults_and_inherited_diagnostics_in_explicit_arguments() {
    let inherited = OsStr::new("--remote-debugging-port=17832 --force_low_power_gpu");
    let (active, stable) = browser_arguments(Mode::Stable, Some(inherited));
    assert!(active == Mode::Stable);
    assert!(stable.starts_with(WRY_ARGUMENTS));
    assert!(stable.contains("--remote-debugging-port=17832 --force_low_power_gpu"));
    assert_eq!(stable.matches(STABLE_SWITCH).count(), 1);
    let (active, accelerated) = browser_arguments(Mode::Accelerated, Some(inherited));
    assert!(active == Mode::Accelerated);
    assert!(accelerated.starts_with(WRY_ARGUMENTS));
    assert!(accelerated.contains("--remote-debugging-port=17832 --force_low_power_gpu"));
    assert!(!accelerated.contains(STABLE_SWITCH));
    let (forced, arguments) = browser_arguments(
        Mode::Accelerated,
        Some(OsStr::new("\"--disable-gpu-compositing\"")),
    );
    assert!(forced == Mode::Stable);
    assert_eq!(arguments.matches(STABLE_SWITCH).count(), 1);
}

#[test]
fn rendering_saves_only_supported_modes_and_reports_restart_required() {
    let root = tempfile::tempdir_in(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/cache"))
        .unwrap();
    let service = Service {
        file: root.path().join("graphics.json"),
        active: Mode::Accelerated,
        preferred: Mutex::new(Mode::Accelerated),
    };
    assert!(service.set(json!({"mode":"stable","flags":"--unsafe"})).is_err());
    assert_eq!(
        service.set(json!({"mode":"stable"})).unwrap(),
        json!({"active":"accelerated","preferred":"stable","restartRequired":true})
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(&service.file).unwrap()).unwrap(),
        json!({"mode":"stable"})
    );
}

#[test]
fn fresh_and_invalid_rendering_preferences_start_in_stable_mode() {
    let root = tempfile::tempdir_in(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/cache"))
        .unwrap();
    let inherited = std::env::var_os(ARGUMENTS);
    for contents in [None, Some("invalid"), Some(r#"{"mode":"unsupported"}"#)] {
        if let Some(value) = contents { std::fs::write(root.path().join("graphics.json"), value).unwrap(); }
        let (service, arguments) = Service::startup(root.path());
        assert_eq!(service.snapshot(), json!({"active":"stable","preferred":"stable","restartRequired":false}));
        assert!(arguments.contains(STABLE_SWITCH));
        assert_eq!(std::env::var_os(ARGUMENTS), inherited);
    }
}

#[test]
fn saved_accelerated_preference_is_preserved_without_mutating_environment() {
    let root = tempfile::tempdir_in(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/cache"))
        .unwrap();
    std::fs::write(root.path().join("graphics.json"), r#"{"mode":"accelerated"}"#).unwrap();
    let inherited = std::env::var_os(ARGUMENTS);
    let (service, arguments) = Service::startup(root.path());
    let forced = inherited.as_ref().is_some_and(|value| value.to_string_lossy().contains(STABLE_SWITCH));
    assert_eq!(service.snapshot()["preferred"], "accelerated");
    assert_eq!(arguments.contains(STABLE_SWITCH), forced);
    assert_eq!(std::env::var_os(ARGUMENTS), inherited);
}
