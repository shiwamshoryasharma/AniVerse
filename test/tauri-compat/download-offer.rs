use super::*;

fn offer() -> Value {
    json!({
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
fn pre_save_validation_binds_the_same_media_and_caption_choice() {
    let selected = from_offer(&offer(), true).unwrap();
    assert!(selected.same_media(&from_offer(&offer(), true).unwrap()));
    let mut changed = offer();
    changed["subtitle"]["language"] = json!("ja");
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
