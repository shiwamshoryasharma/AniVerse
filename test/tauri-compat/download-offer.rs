use super::*;

fn offer() -> Value {
    json!({
        "identity":"document-1:video-1",
        "media":"blob:https://source.example.test/selected",
        "url":"https://media.example.test/episode.m3u8",
        "expectedDuration":1200.0,
        "playlists":["https://media.example.test/episode.m3u8"],
        "observations":["https://media.example.test/1.webp","https://media.example.test/0.png"],
        "subtitle":{"url":"https://captions.example.test/en.vtt","language":"en","label":"English"}
    })
}
#[test]
fn binds_bounded_image_suffix_evidence_and_explicit_public_caption_origin() {
    let value = from_offer(&offer(), true).unwrap();
    assert_eq!(value.selection.observations.len(), 2);
    assert_eq!(value.selection.expected_duration, Some(1200.0));
    assert_eq!(
        value.selection.subtitle.unwrap().url.unwrap().host_str(),
        Some("captions.example.test")
    );
}
#[test]
fn rejects_private_unbounded_or_ambiguous_download_descriptors() {
    for (key, value) in [
        ("url", json!("https://127.0.0.1/episode.m3u8")),
        ("url", json!("https://u:p@media.example.test/episode.m3u8")),
        (
            "url",
            json!("https://media.example.test/episode.m3u8#fragment"),
        ),
        (
            "url",
            json!("https://media.example.test/episode.m3u8?unowned=value"),
        ),
        ("observations", json!([])),
        (
            "observations",
            json!(vec!["https://media.example.test/0.png"; 33]),
        ),
        (
            "playlists",
            json!(vec!["https://media.example.test/a.m3u8"; 9]),
        ),
        (
            "subtitle",
            json!({"url":"https://169.254.169.254/caption.vtt"}),
        ),
        ("expectedDuration", json!(-1.0)),
    ] {
        let mut input = offer();
        input[key] = value;
        assert!(from_offer(&input, true).is_none(), "{key}");
    }
    let mut input = offer();
    input["unexpected"] = json!(true);
    assert!(from_offer(&input, true).is_none());
}
#[test]
fn pre_save_validation_binds_the_same_video_and_keeps_the_captured_caption_choice() {
    let selected = from_offer(&offer(), true).unwrap();
    assert!(selected.same_media(&from_offer(&offer(), true).unwrap()));
    let mut changed = offer();
    changed["subtitle"]["language"] = json!("ja");
    assert!(selected.same_media(&from_offer(&changed, true).unwrap()));
    assert_eq!(
        selected
            .selection
            .subtitle
            .as_ref()
            .unwrap()
            .language
            .as_deref(),
        Some("en")
    );
    let mut changed = offer();
    changed["identity"] = json!("document-1:video-2");
    assert!(!selected.same_media(&from_offer(&changed, true).unwrap()));
    let mut changed = offer();
    changed["media"] = json!("blob:https://source.example.test/another");
    assert!(!selected.same_media(&from_offer(&changed, true).unwrap()));
}

#[test]
fn query_references_require_an_owned_frame_and_the_exact_captured_playlist() {
    let mut input = offer();
    input["url"] = json!("https://media.example.test/episode.m3u8?ticket=opaque%2Fvalue");
    input["playlists"][0] = input["url"].clone();
    input["observations"][0] = json!("https://media.example.test/1.webp?part=opaque");
    input["subtitle"]["url"] = json!("https://captions.example.test/en.vtt?ticket=opaque");
    assert!(
        from_offer(&input, false).is_none(),
        "An unowned query URL remains rejected"
    );
    let selected = from_offer(&input, true).unwrap();
    assert_eq!(selected.url.query(), Some("ticket=opaque%2Fvalue"));
    assert!(
        !downloads::public_media_url(&selected.url),
        "Generic/manual URL policy remains queryless"
    );
    input["playlists"][0] = json!("https://media.example.test/other.m3u8?ticket=opaque");
    assert!(
        from_offer(&input, true).is_none(),
        "An arbitrary query root cannot borrow another observed playlist"
    );
}

#[test]
fn same_playing_video_survives_playlist_order_and_caption_discovery_churn() {
    let selected = from_offer(&offer(), true).unwrap();
    let mut advanced = offer();
    advanced["url"] = json!("https://media.example.test/audio.m3u8");
    advanced["playlists"] = json!([
        "https://media.example.test/audio.m3u8",
        "https://media.example.test/episode.m3u8"
    ]);
    advanced["observations"] = json!([
        "https://media.example.test/new-audio.webp",
        "https://media.example.test/new-video.png"
    ]);
    advanced["expectedDuration"] = json!(1200.02);
    advanced["subtitle"]["label"] = json!("English CC");
    assert!(
        selected.same_media(&from_offer(&advanced, true).unwrap()),
        "Ordinary continued playback is not a changed selected video"
    );
}

#[test]
fn detects_signed_extensionless_direct_media_only_from_the_owned_response() {
    let url = "https://media.example.test/asset?ticket=opaque%2Fvalue";
    let unowned = "https://other.example.test/asset?ticket=another";
    let direct = json!({
        "identity":"document-1:video-1",
        "media":url,
        "url":url,
        "expectedDuration":120.0
    });
    let mut proof = reqwest::header::HeaderMap::new();
    proof.insert(
        reqwest::header::COOKIE,
        "fixture_session=owned".parse().unwrap(),
    );
    let unrelated = download_network::Response::test_entry(unowned, "video/mp4", proof.clone());
    let actual = download_network::Response::test_entry(url, "video/webm", proof);
    assert!(from_observed_offer(&direct, true, &[unrelated.clone()]).is_none());
    assert!(from_observed_offer(&direct, false, &[actual.clone()]).is_none());
    let selected = from_observed_offer(&direct, true, &[actual, unrelated]).unwrap();
    assert_eq!(selected.selection.format, Some(MediaFormat::Webm));
    assert!(selected.selection.owned_root);
    assert_eq!(selected.selection.request_contexts.len(), 1);
    assert!(selected
        .selection
        .request_contexts
        .contains_key(&selected.url));

    let generic =
        download_network::Response::test_entry(url, "application/octet-stream", Default::default());
    let selected = from_observed_offer(&direct, true, &[generic]).unwrap();
    assert!(selected.selection.owned_root);
    assert_eq!(selected.selection.format, None);
}

#[test]
fn selects_extensionless_dash_only_from_the_owned_frame_urls() {
    let manifest = "https://media.example.test/describe?ticket=opaque";
    let segment = "https://media.example.test/part/1";
    let mut view = json!({
        "identity":"document-1:video-1",
        "media":"blob:https://source.example.test/selected",
        "url":segment,
        "expectedDuration":120.0,
        "observations":[segment],
        "resources":[segment]
    });
    let header = download_network::Response::test_entry(
        manifest,
        "application/dash+xml",
        Default::default(),
    );
    assert!(from_observed_offer(&view, true, &[header.clone()]).is_none());
    view["resources"] = json!([segment, manifest]);
    let selected = from_observed_offer(&view, true, &[header]).unwrap();
    assert_eq!(selected.selection.format, Some(MediaFormat::Dash));
    assert_eq!(selected.url.as_str(), manifest);
    assert_eq!(selected.selection.observations[0].as_str(), segment);
    assert!(selected.selection.owned_root);
}
