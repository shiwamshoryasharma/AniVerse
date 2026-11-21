use super::*;

#[test]
fn dedicated_preference_reaches_webview_and_respects_system_and_inherited_options() {
    let custom = OsString::from("--remote-debugging-port=17920");
    let (active, args) = browser_arguments(Preference::HighPerformance, &custom, true);
    assert!(active == Preference::HighPerformance);
    assert_eq!(
        args.unwrap(),
        "--remote-debugging-port=17920 --force_high_performance_gpu"
    );
    assert!(browser_arguments(Preference::System, &custom, true)
        .1
        .is_none());
    assert!(
        browser_arguments(Preference::HighPerformance, &custom, false)
            .1
            .is_none()
    );
    let low = OsString::from("--force_low_power_gpu");
    let (forced, args) = browser_arguments(Preference::HighPerformance, &low, true);
    assert!(forced == Preference::PowerSaving && args.is_none());
    let disabled = OsString::from("--disable-gpu");
    assert!(
        browser_arguments(Preference::HighPerformance, &disabled, true)
            .1
            .is_none()
    );
    assert!(
        serde_json::from_value::<Setting>(json!({"preference":"--ignore-gpu-blocklist"})).is_err()
    );
    assert!(
        serde_json::from_value::<Setting>(json!({"preference":"system","flags":"arbitrary"}))
            .is_err()
    );
}
