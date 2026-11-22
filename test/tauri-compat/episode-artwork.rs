use super::*;

#[test]
fn selects_only_missing_dom_card_images_near_current_episode() {
    let raw=json!((1..=40).map(|episode|json!({"episode":episode,"thumbnail":format!("https://images.test/{episode}.png")})).collect::<Vec<_>>());
    let cards=json!((1..=40).map(|episode|json!({"episode":episode,"thumbnail":if episode==20{json!("data:image/jpeg;base64,/9j/")}else{Value::Null}})).collect::<Vec<_>>());
    let result = candidates(&raw, &cards, 20);
    assert_eq!(result.len(), 16);
    assert!(result.iter().all(|(episode, _)| *episode != 20));
    assert!(result
        .windows(2)
        .all(|pair| pair[0].0.abs_diff(20) <= pair[1].0.abs_diff(20)));
}

#[test]
fn rejects_privileged_credentials_unknown_cards_and_duplicate_episodes() {
    let raw = json!([
        {"episode":1,"thumbnail":"file:///C:/private.png"},
        {"episode":2,"thumbnail":"https://user:pass@images.test/a.png"},
        {"episode":3,"thumbnail":"data:image/png;base64,AA=="},
        {"episode":4,"thumbnail":"https://images.test/four.png"},
        {"episode":4,"thumbnail":"https://other.test/four.png"},
        {"episode":5,"thumbnail":"https://images.test/five.png"}
    ]);
    let cards = json!((1..=4)
        .map(|episode| json!({"episode":episode,"thumbnail":null}))
        .collect::<Vec<_>>());
    assert_eq!(
        candidates(&raw, &cards, 4),
        vec![(4, "https://images.test/four.png".into())]
    );
}

#[test]
fn rejects_non_image_oversized_and_non_base64_browser_resources() {
    for bytes in [
        b"<html>private data</html>".as_slice(),
        b"<svg xmlns='http://www.w3.org/2000/svg'/>".as_slice(),
        b"video data".as_slice(),
    ] {
        assert!(
            image_bytes(&json!({"base64Encoded":true,"content":STANDARD.encode(bytes)})).is_none()
        );
    }
    assert!(image_bytes(&json!({"base64Encoded":false,"content":"plain"})).is_none());
    assert!(image_bytes(&json!({"base64Encoded":true,"content":"!invalid"})).is_none());
    assert!(image_bytes(
        &json!({"base64Encoded":true,"content":STANDARD.encode(vec![0u8;MAX_IMAGE+1])})
    )
    .is_none());
    for bytes in [
        b"\x89PNG\r\n\x1a\nfixture".as_slice(),
        b"\xff\xd8\xfffixture".as_slice(),
        b"RIFF1234WEBPfixture".as_slice(),
    ] {
        assert_eq!(
            image_bytes(&json!({"base64Encoded":true,"content":STANDARD.encode(bytes)})).as_deref(),
            Some(bytes)
        );
    }
}

#[test]
fn reads_only_matching_top_frame_image_resources() {
    let tree = json!({"frame":{"id":"owned"},"resources":[
        {"url":"https://images.test/episode.png","type":"Image","mimeType":"image/png"},
        {"url":"https://images.test/document","type":"Document","mimeType":"text/html"}
    ]});
    assert_eq!(
        image_resource(&tree, "https://images.test/episode.png"),
        Some("owned")
    );
    assert_eq!(image_resource(&tree, "https://images.test/document"), None);
    assert_eq!(image_resource(&tree, "https://images.test/other.png"), None);
}
