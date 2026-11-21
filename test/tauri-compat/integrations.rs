use super::*;
use rusqlite::params;
use std::{fs, path::PathBuf};

fn cache() -> PathBuf {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/cache/aniverse2");
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn native_vault_profile_binding_and_account_disconnection() {
    let profile = tempfile::tempdir_in(cache()).unwrap();
    let other = tempfile::tempdir_in(cache()).unwrap();
    let root = profile.path();
    let sealed = vault::seal(root, "fixture-token").unwrap();
    vault::seal(other.path(), "unrelated-token").unwrap();
    assert_eq!(vault::open(root, &sealed).unwrap(), "fixture-token");
    assert!(vault::open(other.path(), &sealed).is_err());
    assert!(vault::open(root, "fixture-token").is_err());
    let db = profile::writable(root).unwrap();
    let account = json!({"provider":"anilist","userName":"Fixture account","token":sealed,"refreshToken":null});
    db.execute(
        "INSERT INTO accounts(provider,data) VALUES('anilist',?1)",
        [account.to_string()],
    )
    .unwrap();
    db.execute("INSERT INTO sync_queue(provider,op,dedupe_key,payload,attempts,last_error,created_at,next_at)
        VALUES('anilist','entry','anilist:entry:1','{}',0,NULL,0,0)", []).unwrap();
    let listing = accounts::list(root).unwrap();
    assert_eq!(listing[0]["connected"], true);
    assert_eq!(listing[0]["pending"], 1);
    assert_eq!(listing[0]["needsReconnect"], false);
    assert!(!listing.to_string().contains("fixture-token"));
    assert_eq!(accounts::token(root, "anilist").unwrap(), "fixture-token");
    accounts::disconnect(root, &json!({"provider":"anilist"})).unwrap();
    assert_eq!(accounts::list(root).unwrap()[0]["connected"], false);
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM sync_queue WHERE provider=?1",
            params!["anilist"],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn comment_text_keeps_safe_markup_and_drops_non_public_links() {
    let text = comment_text::html("<strong>Festival</strong><br/><a href='https://example.com/post'>Reply</a><img src='http://127.0.0.1/x'><a href='javascript:alert(1)'>Ignore me</a>");
    assert_eq!(
        text,
        "**Festival**\n[Reply](https://example.com/post)Ignore me"
    );
    assert_eq!(
        comment_text::bbcode("[b]word[/b][spoiler]ending[/spoiler]"),
        "**word**~!ending!~"
    );
    assert_eq!(
        comment_text::anilist("youtube(short-id)"),
        "[video](https://youtu.be/short-id)"
    );
}

#[test]
#[ignore = "generate the isolated Electron 44 credential fixture before testing"]
fn decrypts_electron_safe_storage_with_only_migrated_protected_key() {
    let src = std::env::var_os("ANIVERSE2_ELECTRON_CREDENTIAL_FIXTURE")
        .expect("isolated Electron fixture");
    let root = PathBuf::from(src).canonicalize().unwrap();
    assert!(root.starts_with(cache().canonicalize().unwrap()));
    let encoded = fs::read_to_string(root.join("ciphertext.txt")).unwrap();
    assert_eq!(
        vault::open(&root, &encoded).unwrap(),
        "electron-fixture-credential"
    );
    let other = tempfile::tempdir_in(cache()).unwrap();
    fs::copy(
        root.join("chromium-encrypted-key.json"),
        other.path().join("chromium-encrypted-key.json"),
    )
    .unwrap();
    fs::write(
        other.path().join("profile.id"),
        "ffffffffffffffffffffffffffffffff",
    )
    .unwrap();
    assert!(vault::open(other.path(), &encoded).is_err());
}
#[test]
fn drive_v1_round_trip_preserves_local_history_and_filters_private_records() {
    let incoming = tempfile::tempdir_in(cache()).unwrap();
    let current = tempfile::tempdir_in(cache()).unwrap();
    {
        let db = profile::writable(incoming.path()).unwrap();
        set_kv(
            &db,
            "settings",
            &json!({"profile":{"name":"Do not export this"},
            "appearance": {"accent":"aqua"}, "player":{"volume":0.4}}),
        )
        .unwrap();
        db.execute(
            "INSERT INTO library(media_id,status,progress,score,updated_at)
            VALUES(1,'CURRENT',1,8,100),(2,'CURRENT',2,6,100)",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO history(media_id,episode,source_id,position,duration,watched_at)
            VALUES(1,3,'source-secret',12,80,100),(2,2,'source-secret',17,80,100)",
            [],
        )
        .unwrap();
        db.execute("INSERT INTO progress(media_id,episode,position,duration,completed,source_id,updated_at)
            VALUES(1,3,12,80,0,'source-secret',100)", []).unwrap();
        db.execute("INSERT INTO private_titles(media_id) VALUES(2)", [])
            .unwrap();
        db.execute("INSERT INTO scene_bookmarks(media_id,episode,position,duration,source_id,note,tags,created_at)
            VALUES(1,3,12,80,'source-secret','Bookmark fixture','[\"action\"]',100)", []).unwrap();
        db.execute(
            "INSERT INTO skip_ranges(media_id,kind,start,end,enabled,source_id,duration)
            VALUES(1,'intro',4,12,1,'source-secret',80)",
            [],
        )
        .unwrap();
    }
    let bytes = drive::backup::create(incoming.path(), "2.2.4").unwrap();
    let contents = String::from_utf8(bytes).unwrap();
    assert!(!contents.contains("source-secret"));
    assert!(!contents.contains("Do not export this"));
    let backup = drive::backup::validate(serde_json::from_str(&contents).unwrap()).unwrap();
    assert_eq!(backup["format"], "aniverse.backup");
    assert_eq!(backup["version"], 1);
    assert_eq!(backup["history"].as_array().unwrap().len(), 1);
    assert_eq!(backup["history"][0]["mediaId"], 1);
    assert_eq!(backup["settings"]["appearance"]["accent"], "aqua");
    let mut invalid = backup.clone();
    invalid["sources"] = json!([]);
    assert!(drive::backup::validate(invalid).is_err());
    let mut foreign = backup.clone();
    foreign["media"][0]["cover"] = json!("https://127.0.0.1/file");
    assert!(drive::backup::validate(foreign).is_err());
    {
        let db = profile::writable(current.path()).unwrap();
        set_kv(&db, "settings", &json!({"profile":{"name":"Preserve me"}})).unwrap();
        db.execute(
            "INSERT INTO library_tombstones(media_id,deleted_at) VALUES(1,150)",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO history(media_id,episode,source_id,position,duration,watched_at)
            VALUES(1,3,'local-source',43,80,150)",
            [],
        )
        .unwrap();
    }
    assert_eq!(
        drive::backup::restore(current.path(), backup.clone(), true).unwrap()["bookmarks"],
        1
    );
    drive::backup::restore(current.path(), backup, true).unwrap();
    let db = profile::writable(current.path()).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM library", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        db.query_row("SELECT position FROM history WHERE media_id=1", [], |r| r
            .get::<_, f64>(
            0
        ))
        .unwrap(),
        43.0
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM scene_bookmarks", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        db.query_row("SELECT enabled FROM skip_ranges", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM sync_queue", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let settings = kv_in(&db, "settings").unwrap();
    assert_eq!(settings["profile"]["name"], "Preserve me");
    assert_eq!(settings["player"]["volume"], 0.4);
}
