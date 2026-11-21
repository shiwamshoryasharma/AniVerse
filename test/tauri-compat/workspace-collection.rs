use super::*;

#[test]
fn collection_uses_legacy_index_and_never_deletes_video() {
    let root = tempfile::tempdir_in(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/cache"))
        .unwrap();
    let media_root = root.path().join("library");
    fs::create_dir(&media_root).unwrap();
    let video = media_root.join("[Fixture] Local.Series S02E03 [1080p].mp4");
    fs::write(&video, b"filesystem test").unwrap();
    let data = root.path().join("data");
    fs::create_dir(&data).unwrap();
    let result = scan(&data, Vec::new(), Some(media_root.clone())).unwrap();
    let row = &result["files"][0];
    assert_eq!(row["query"], "Local Series Season 2");
    assert_eq!(row["episode"], 3);
    assert!(row.get("path").is_none());
    let id = row["id"].as_i64().unwrap();
    let item = write(&data, |db| {
        matched(
            db,
            &json!({"id":id,"media":{"id":1,"title":"Local Series","cover":""},"episode":4}),
        )
    })
    .unwrap();
    assert_eq!(item["media"]["id"], 1);
    assert_eq!(item["episode"], 4);
    let (indexed, allowed, _) = opened(&data, id).unwrap();
    assert_eq!(
        indexed.canonicalize().unwrap(),
        video.canonicalize().unwrap()
    );
    assert_eq!(allowed, vec![media_root.canonicalize().unwrap()]);
    let rescanned = scan(&data, vec![media_root], None).unwrap();
    assert_eq!(rescanned["files"][0]["episode"], 4);
    write(&data, |db| {
        db.execute("DELETE FROM local_media WHERE id=?1", [id])
            .map_err(read_error)?;
        Ok(())
    })
    .unwrap();
    assert!(video.is_file());
}
