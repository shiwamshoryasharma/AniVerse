use super::*;

#[test]
fn visual_theme_validates_legacy_defaults_and_rejects_extra_fields() {
    let legacy = json!({"version":1,"name":" Fixture ","appearance":{"accent":"aqua","density":"compact","fontFamily":"mono","reduceMotion":true},
        "player":{"theater":false,"preferredQuality":"480"}});
    let normalized = preset(&legacy).unwrap();
    assert_eq!(normalized["name"], "Fixture");
    assert_eq!(normalized["appearance"]["style"], "classic");
    let mut arbitrary = normalized.clone();
    arbitrary["appearance"]["css"] = json!("body{}");
    assert!(preset(&arbitrary).is_none());
    let root = tempfile::tempdir_in(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/cache"))
        .unwrap();
    let saved = write(root.path(), |db| save(db, &legacy)).unwrap();
    assert_eq!(
        selected(root.path(), &json!({"id":saved["id"]})).unwrap(),
        normalized
    );
}
