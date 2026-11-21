use super::*;

#[test]
fn toolkit_persists_legacy_rows_and_preserves_privacy() {
    let root = tempfile::tempdir_in(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/cache"))
        .unwrap();
    let path = root.path();
    let observer = Observer::default();
    let run = |method, input| request(path, &observer, method, &input);
    let media = json!({"id":7, "idMal":null, "title":"Fixture Show","cover":"","banner":null,"format":"TV","episodes":8});
    let input = json!({"media":media,"episode":2,"position":40.5,"duration":100.0,"sourceId":"fixture",
        "note":" Scene note ", "tags":["one"," one ","two"]});
    let bookmark = run("toolkit.saveBookmark", input.clone()).unwrap();
    assert_eq!(bookmark["tags"], json!(["one", "two"]));
    assert_eq!(
        run("toolkit.bookmarks", json!({"search":"note"})).unwrap()[0],
        bookmark
    );
    assert!(run("toolkit.saveSkip", json!({"mediaId":7,"kind":"intro","start":10,"end":9,"duration":100,"enabled":true,"sourceId":"fixture"})).is_err());
    assert_eq!(run("toolkit.saveSkip", json!({"mediaId":7,"kind":"intro","start":4,"end":8,"duration":100,"enabled":true,"sourceId":"fixture"})).unwrap()[0]["start"],4.0);

    let point = json!({"sessionId":"fixture-1","mediaId":7,"episode":2,"sourceId":"fixture","position":15,"duration":100,"paused":false,"totalFrames":30,"droppedFrames":2});
    run("toolkit.record", point.clone()).unwrap();
    assert_eq!(
        run("toolkit.insights", Value::Null).unwrap()["sources"],
        json!([])
    );
    write(path, |db| {
        super::super::set(db, "settings", &json!({"privacy":{"watchInsights":true}}))
    })
    .unwrap();
    run("toolkit.record", point.clone()).unwrap();
    observer.0.lock().unwrap().get_mut("fixture-1").unwrap().at -= Duration::from_secs(2);
    let mut second = point.clone();
    second["position"] = json!(17);
    second["totalFrames"] = json!(90);
    second["droppedFrames"] = json!(5);
    run("toolkit.record", second).unwrap();
    let summary = run("toolkit.insights", Value::Null).unwrap();
    assert!(summary["watchedSeconds"].as_f64().unwrap() >= 2.0);
    assert_eq!(summary["sources"][0]["dropPercent"], 5.0);

    write(path, |db| {
        db.execute("INSERT INTO private_titles(media_id) VALUES(7)", [])
            .map_err(read_error)?;
        Ok(())
    })
    .unwrap();
    assert_eq!(run("toolkit.bookmarks", json!({})).unwrap(), json!([]));
    assert_eq!(
        run("toolkit.skips", json!({"mediaId":7})).unwrap(),
        json!([])
    );
    assert!(run("toolkit.saveBookmark", input).is_err());
    run("toolkit.record", point).unwrap();
    assert_eq!(
        run("toolkit.insights", Value::Null).unwrap()["sources"],
        json!([])
    );
    run("toolkit.clearInsights", Value::Null).unwrap();
    let database = open(path).unwrap().unwrap();
    let count: i64 = database
        .query_row("SELECT COUNT(*) FROM watch_sessions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
}
