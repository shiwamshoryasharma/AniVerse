use super::*;
use rusqlite::params;
use serde_json::json;

#[test]
fn network_rules_and_persisted_opt_outs_are_applied_without_mixing_denial_counts() {
    let root = tempfile::tempdir_in(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/cache"))
        .unwrap();
    let path = root.path();
    std::fs::create_dir(path.join("config")).unwrap();
    std::fs::write(
        path.join("config/streaming-sites.txt"),
        "https://first.test/\nhttps://second.test/\n",
    )
    .unwrap();
    let db = profile::writable(path).unwrap();
    db.execute(
        "INSERT INTO kv(key,value) VALUES('settings',?1)",
        [json!({"privacy":{"adblock":false}}).to_string()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO source_overrides(id,data) VALUES(?1,?2)",
        params!["first-test", json!({"adblock":false}).to_string()],
    )
    .unwrap();
    drop(db);
    std::fs::write(
        path.join("rust-network-filters.txt"),
        "||tracker.test^$script,third-party\n@@||tracker.test/allowed.js$script",
    )
    .unwrap();
    std::fs::write(
        path.join("config/filters.txt"),
        "||local-rule.test^$image\nfirst.test##.banner",
    )
    .unwrap();
    let engine = std::sync::Arc::new(Service::new(path));
    assert!(!engine.snapshot().enabled);
    assert!(!engine.enabled_for("first-test"));
    assert!(!engine.snapshot().ready);
    tauri::async_runtime::block_on(async {
        let concurrent = engine.clone();
        let other = tauri::async_runtime::spawn(async move { concurrent.ensure_ready().await });
        engine.ensure_ready().await;
        other.await.unwrap();
    });
    assert!(engine.snapshot().ready);
    let blocks = |id, url, kind| engine.blocks(id, "https://first.test/", url, kind, "GET");
    assert!(!blocks(
        "second-test",
        "https://tracker.test/tag.js",
        "script"
    ));
    engine.set_enabled(true);
    assert!(!blocks(
        "first-test",
        "https://tracker.test/tag.js",
        "script"
    ));
    assert!(blocks(
        "second-test",
        "https://tracker.test/tag.js",
        "script"
    ));
    assert!(!blocks(
        "second-test",
        "https://tracker.test/allowed.js",
        "script"
    ));
    engine.set_source("first-test", true);
    assert!(blocks(
        "first-test",
        "https://local-rule.test/banner.png",
        "image"
    ));
    engine.count("first-test", Denial::Network);
    engine.count("first-test", Denial::Security);
    engine.count("second-test", Denial::Popup);
    let status = serde_json::to_value(engine.snapshot()).unwrap();
    assert_eq!(status["blocked"], json!({"first-test":1}));
    assert_eq!(status["securityBlocked"], json!({"first-test":1}));
    assert_eq!(status["popupsBlocked"], json!({"second-test":1}));
}
