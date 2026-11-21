use super::*;

#[test]
fn migrated_user_and_recipe_templates_precede_old_discovery() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/cache/aniverse2");
    let fixture = tempfile::tempdir_in(root).unwrap();
    let root = fixture.path();
    std::fs::create_dir(root.join("config")).unwrap();
    std::fs::write(
        root.join(SITES_FILE),
        "https://www.example.test/home\nhttps://second.test/\nhttps://third.test/\nhttps://last.test/\n",
    )
    .unwrap();
    std::fs::write(
        root.join(RECIPES_FILE),
        r#"{
          "EXAMPLE.TEST":{"search":"https://www.example.test/from-recipe?q={query}"},
          "second.test":{"search":"https://second.test/#/search?q={query}"},
          "last.test":{"search":"https://external.test/search?q={query}"}
        }"#,
    )
    .unwrap();
    let db = profile::writable(root).unwrap();
    db.execute(
        "INSERT INTO source_overrides (id,data) VALUES ('example-test',?1)",
        [
            json!({"searchTemplate":"https://www.example.test/from-settings?q={query}"})
                .to_string(),
        ],
    )
    .unwrap();
    for host in ["www.example.test", "second.test", "third.test", "last.test"] {
        let id = host.trim_start_matches("www.").replace('.', "-");
        let stored = json!({"template":format!("https://{host}/cache?q={{query}}"),"via":"opensearch","at":10,"origin":(host=="last.test").then_some("https://other.test")});
        db.execute(
            "INSERT INTO kv (key,value) VALUES (?1,?2)",
            params![format!("discovery:{id}"), stored.to_string()],
        )
        .unwrap();
    }
    let entries = list(root, Some(&db)).unwrap();
    assert_eq!(entries[0]["searchTemplateSource"], "user");
    assert_eq!(entries[1]["searchTemplateSource"], "recipe");
    assert_eq!(
        entries[1]["searchTemplate"],
        "https://second.test/#/search?q={query}"
    );
    assert_eq!(entries[2]["searchTemplateSource"], "opensearch");
    assert_eq!(entries[2]["searchCheckedAt"], 10);
    assert!(entries[3]["searchTemplate"].is_null());
    for forbidden in [
        "https://someone:pass@last.test/search?q={query}",
        "https://last.test/{query}?q={query}",
        "https://{query}.last.test/find",
        "https://last.test/?{query}=secret",
        "https://another.test/search?q={query}",
    ] {
        assert!(
            search_template(Some(forbidden), &Url::parse("https://last.test").unwrap()).is_none()
        );
    }
}
