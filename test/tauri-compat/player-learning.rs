use super::*;

fn test_directory() -> tempfile::TempDir {
    let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/cache/aniverse2");
    std::fs::create_dir_all(&base).unwrap();
    tempfile::Builder::new().prefix("native-patterns-").tempdir_in(base).unwrap()
}

#[test]
fn generalizes_confirmed_structure_and_keeps_distinct_layouts() {
    let dir = test_directory();
    let patterns = Service::new(dir.path());
    patterns.remember("https://one.test", "episodeLink", "a.episode-row", false);
    patterns.remember("https://www.one.test", "episodeLink", "a.episode-row", false);
    assert_eq!(patterns.selector("https://next.test", "episodeLink", false), None);
    patterns.remember("https://two.test", "episodeLink", "a.episode-row", false);
    assert_eq!(patterns.selector("https://next.test", "episodeLink", false).as_deref(), Some("a.episode-row"));
    patterns.remember("https://next.test", "episodeLink", "button.play-card", false);
    patterns.remember("https://next.test", "episodeLink", "a[href*='/episode/42']", false);
    patterns.remember("https://next.test", "episodeLink", "#play-button", true);
    drop(patterns);
    let restarted = Service::new(dir.path());
    assert_eq!(restarted.selector("https://next.test", "episodeLink", false).as_deref(), Some("button.play-card"));
    assert_eq!(restarted.selector("https://next.test", "episodeLink", true), None);
}

#[test]
fn audio_keeps_source_and_privacy_boundaries_and_unknown_counts() {
    let dir = test_directory();
    let patterns = Service::new(dir.path());
    let sub = json!([{"episode":1,"audio":["sub"]}]);
    let dub = json!([{"episode":2,"audio":["dub"]}]);
    patterns.observe_audio("source", "https://one.test", 24, &sub, false);
    patterns.observe_audio("source", "https://one.test", 25, &dub, true);
    assert_eq!(patterns.hover("source", "https://two.test", 24), Value::Null);
    assert_eq!(patterns.hover("source", "https://one.test", 25), Value::Null);
    assert_eq!(patterns.hover("source", "https://one.test", 24), json!({"sub":1,"dub":null,"total":null}));
    patterns.observe_audio("source", "https://one.test", 24, &dub, false);
    let known = BTreeMap::from([("source".to_owned(), "https://one.test".to_owned())]);
    assert_eq!(patterns.observed(&known, &BTreeSet::from([24])), json!([]));
    let rows = patterns.observed(&known, &BTreeSet::new());
    assert_eq!(rows[0]["audio"], json!(["sub","dub"]));
    assert_eq!(rows[0]["episodes"], json!([{"episode":1,"audio":["sub"]},{"episode":2,"audio":["dub"]}]));
    assert_eq!(Service::new(dir.path()).hover("source", "https://one.test", 24), Value::Null);
}