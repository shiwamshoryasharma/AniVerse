use super::*;

fn test_directory() -> tempfile::TempDir {
    let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/cache/aniverse2");
    std::fs::create_dir_all(&base).unwrap();
    tempfile::Builder::new()
        .prefix("native-patterns-")
        .tempdir_in(base)
        .unwrap()
}

#[test]
fn generalizes_confirmed_structure_and_keeps_distinct_layouts() {
    let dir = test_directory();
    let patterns = Service::new(dir.path());
    patterns.remember("https://one.test", "episodeLink", "a.episode-row", false);
    patterns.remember(
        "https://www.one.test",
        "episodeLink",
        "a.episode-row",
        false,
    );
    assert_eq!(
        patterns.selector("https://next.test", "episodeLink", false),
        None
    );
    patterns.remember("https://two.test", "episodeLink", "a.episode-row", false);
    assert_eq!(
        patterns
            .selector("https://next.test", "episodeLink", false)
            .as_deref(),
        Some("a.episode-row")
    );
    patterns.remember(
        "https://next.test",
        "episodeLink",
        "button.play-card",
        false,
    );
    patterns.remember(
        "https://next.test",
        "episodeLink",
        "a[href*='/episode/42']",
        false,
    );
    patterns.remember("https://next.test", "episodeLink", "#play-button", true);
    drop(patterns);
    let restarted = Service::new(dir.path());
    assert_eq!(
        restarted
            .selector("https://next.test", "episodeLink", false)
            .as_deref(),
        Some("button.play-card")
    );
    assert_eq!(
        restarted.selector("https://next.test", "episodeLink", true),
        None
    );
}

#[test]
fn audio_keeps_source_and_privacy_boundaries_and_unknown_counts() {
    let dir = test_directory();
    let patterns = Service::new(dir.path());
    let sub = json!([{"episode":1,"audio":["sub"]}]);
    let dub = json!([{"episode":2,"audio":["dub"]}]);
    patterns.observe_audio("source", "https://one.test", 24, &sub, false);
    patterns.observe_audio("source", "https://one.test", 25, &dub, true);
    assert_eq!(
        patterns.hover("source", "https://two.test", 24),
        Value::Null
    );
    assert_eq!(
        patterns.hover("source", "https://one.test", 25),
        Value::Null
    );
    assert_eq!(
        patterns.hover("source", "https://one.test", 24),
        json!({"sub":1,"dub":null,"total":null})
    );
    patterns.observe_audio("source", "https://one.test", 24, &dub, false);
    let known = BTreeMap::from([("source".to_owned(), "https://one.test".to_owned())]);
    assert_eq!(patterns.observed(&known, &BTreeSet::from([24])), json!([]));
    let rows = patterns.observed(&known, &BTreeSet::new());
    assert_eq!(rows[0]["audio"], json!(["sub", "dub"]));
    assert_eq!(
        rows[0]["episodes"],
        json!([{"episode":1,"audio":["sub"]},{"episode":2,"audio":["dub"]}])
    );
    assert_eq!(
        Service::new(dir.path()).hover("source", "https://one.test", 24),
        Value::Null
    );
}

#[test]
fn episode_routes_use_only_valid_structural_hints() {
    let directory = test_directory();
    let origin = "https://native.test";
    let template = r#"button[data-episode="{n}"]"#;
    let learned = Service::new(directory.path());
    learned.remember_verified(
        origin,
        [
            ("episodeLink", template.into()),
            ("episodeStep", EpisodeStep::EpisodesTab.name().into()),
            ("watchLink", r#"a[href*="/watch/private-title/42"]"#.into()),
            ("titleLink", template.into()),
        ],
        false,
    );
    drop(learned);

    let patterns = Service::new(directory.path());
    assert_eq!(
        patterns.selector(origin, "episodeLink", false).as_deref(),
        Some(template)
    );
    assert_eq!(patterns.selector(origin, "watchLink", false), None);
    assert_eq!(patterns.selector(origin, "titleLink", false), None);
    assert!(
        patterns.episode_steps(origin, false)
            == [
                EpisodeStep::EpisodesTab,
                EpisodeStep::Direct,
                EpisodeStep::WatchLink,
            ]
    );
    assert!(patterns.episode_steps(origin, true) == EpisodeStep::DEFAULT);
    assert!(patterns.episode_steps("https://other.test", false) == EpisodeStep::DEFAULT);

    patterns.forget(origin, "episodeLink", "button.other-match", false);
    assert_eq!(
        patterns.selector(origin, "episodeLink", false).as_deref(),
        Some(template)
    );
    patterns.forget(origin, "episodeLink", template, true);
    assert_eq!(
        patterns.selector(origin, "episodeLink", false).as_deref(),
        Some(template)
    );
    patterns.forget(origin, "episodeLink", template, false);
    assert_eq!(
        Service::new(directory.path()).selector(origin, "episodeLink", false),
        None
    );
}

#[test]
fn existing_episode_audio_expires_per_observed_mode() {
    let directory = test_directory();
    let origin = "https://source.test";
    let patterns = Service::new(directory.path());
    patterns.observe_audio(
        "source",
        origin,
        24,
        &json!([{"episode":1,"audio":["dub"]},{"episode":2,"audio":["sub"]}]),
        false,
    );
    let prior = patterns.observed.lock().unwrap()[0].episodes[&1][1];
    patterns.observe_audio(
        "source",
        origin,
        24,
        &json!([{"episode":1,"audio":["sub"]}]),
        false,
    );
    let observations = patterns.observed.lock().unwrap();
    let latest = &observations[0].episodes;
    assert!(latest[&1][0].is_some());
    assert_eq!(
        latest[&1][1], prior,
        "A new SUB observation must not redate DUB"
    );
    assert!(!fresh(prior, prior.unwrap() + AUDIO_TTL));
    assert!(fresh(
        latest[&2][0],
        latest[&2][0].unwrap() + AUDIO_TTL - Duration::from_millis(1)
    ));
}
