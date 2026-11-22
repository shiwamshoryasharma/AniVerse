use super::*;
use serde_json::json;

#[test]
fn names_series_season_episode_and_preserves_unicode() {
    assert_eq!(
        episode_filename(&json!({"title":"Example Series","season":2,"episode":7})).as_deref(),
        Some("Example Series - S02E07.mp4")
    );
    assert_eq!(
        episode_filename(&json!({"title":"Example Series","episode":120})).as_deref(),
        Some("Example Series - S01E120.mp4")
    );
    assert_eq!(
        episode_filename(&json!({"title":"  例の物語 / 帰還: 「空」?  ","season":3,"episode":9}))
            .as_deref(),
        Some("例の物語 _ 帰還_ 「空」_ - S03E09.mp4")
    );
}

#[test]
fn bounds_and_sanitizes_the_local_name_only() {
    assert_eq!(
        episode_filename(&json!({"title":"CON","episode":1})).as_deref(),
        Some("_CON - S01E01.mp4")
    );
    assert_eq!(
        episode_filename(&json!({"title":" ... ","episode":1})).as_deref(),
        Some("Series - S01E01.mp4")
    );
    assert_eq!(
        episode_filename(&json!({"title":"🌙".repeat(140),"season":99,"episode":10000})),
        Some(format!("{} - S99E10000.mp4", "🌙".repeat(100)))
    );
    for value in [
        json!({"title":"","episode":1}),
        json!({"title":"Series","season":0,"episode":1}),
        json!({"title":"Series","episode":1.5}),
        json!({"title":"Series","episode":0}),
        json!({"title":"Series","episode":10001}),
        json!({"title":"x".repeat(301),"episode":1}),
        json!({"title":"Series","episode":1,"destination":"C:\\other"}),
    ] {
        assert!(episode_filename(&value).is_none());
    }
}
