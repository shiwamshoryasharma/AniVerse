use super::*;
use reconcile::{reconcile, Target, Timed};
use std::path::PathBuf;

#[test]
fn account_merge_prefers_newest_preserves_local_score_and_does_not_resurrect_missing_titles() {
    let local = Entry {
        status: "CURRENT".into(),
        progress: 2,
        score: Some(8.2),
    };
    let remote = Entry {
        status: "CURRENT".into(),
        progress: 3,
        score: None,
    };
    let targets = [
        Target {
            provider: "anilist",
            entry: Some(Timed {
                entry: Some(&remote),
                at: 50,
            }),
            last_sync: Some(45),
        },
        Target {
            provider: "mal",
            entry: None,
            last_sync: Some(60),
        },
    ];
    let plan = reconcile(
        Timed {
            entry: Some(&local),
            at: 40,
        },
        &targets,
    );
    let (changed, changed_at) = plan.apply.unwrap();
    assert_eq!(changed.progress, 3);
    assert_eq!(changed.score, Some(8.2));
    assert_eq!(changed_at, 50);
    assert_eq!(plan.winner, Some(0));
    assert!(plan.push.is_empty());

    let plan = reconcile(
        Timed {
            entry: None,
            at: 75,
        },
        &targets,
    );
    assert_eq!(plan.push, vec![0]);
    assert!(plan.apply.is_none());
}

#[test]
fn account_sync_database_drops_stale_queue_and_preserves_pending_other_titles() {
    let cache = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/cache/aniverse2");
    std::fs::create_dir_all(&cache).unwrap();
    let root = tempfile::tempdir_in(cache).unwrap();
    let snapshot = |id| json!({"id":id,"idMal":id,"title":"Fixture title","cover":"","banner":null,"format":"TV","episodes":12});
    let entry = Entry {
        status: "CURRENT".into(),
        progress: 5,
        score: None,
    };
    let db = profile::writable(root.path()).unwrap();
    db.execute("INSERT INTO private_titles(media_id) VALUES(2)", [])
        .unwrap();
    db.execute(
        "INSERT INTO library(media_id,status,progress,score,updated_at) VALUES(1,'CURRENT',2,8,30)",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO media_snapshot(id,data,updated_at) VALUES(1,?1,30)",
        [snapshot(1).to_string()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO sync_queue(provider,op,dedupe_key,payload,attempts,created_at,next_at)
        VALUES('anilist','status','anilist:status:1','{\"mediaId\":1}',0,1,1),
          ('mal','entry','mal:entry:9','{\"mediaId\":9}',0,1,1)",
        [],
    )
    .unwrap();
    let mut remote = Remote::default();
    remote.insert(RemoteEntry {
        media: snapshot(1),
        entry: entry.clone(),
        updated: 40,
    });
    remote.insert(RemoteEntry {
        media: snapshot(2),
        entry,
        updated: 40,
    });
    let session = Session {
        provider: "anilist",
        token: "fixture-no-network".into(),
        user: Some(1),
        last_sync: None,
        privacy_epoch: crate::runtime_privacy::epoch(),
    };
    let mut report = Report::default();
    state::merge(root.path(), &[(session, Some(remote))], &mut report).unwrap();
    assert_eq!(report.pulled, 1);
    assert_eq!(report.resolved, 1);
    let record = db
        .query_row(
            "SELECT progress,score FROM library WHERE media_id=1",
            [],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)?)),
        )
        .unwrap();
    assert_eq!(record, (5, 8.0));
    assert_eq!(
        db.query_row("SELECT count(*) FROM library WHERE media_id=2", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        0
    );
    assert_eq!(
        db.query_row("SELECT dedupe_key FROM sync_queue", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "mal:entry:9"
    );
}

#[test]
fn account_sync_queues_local_edits_atomically_and_respects_privacy_and_pause() {
    let cache = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/cache/aniverse2");
    std::fs::create_dir_all(&cache).unwrap();
    let root = tempfile::tempdir_in(cache).unwrap();
    let db = profile::writable(root.path()).unwrap();
    db.execute(
        "INSERT INTO accounts(provider,data) VALUES('anilist','{}'),('mal','{}')",
        [],
    )
    .unwrap();
    db.execute("INSERT INTO private_titles(media_id) VALUES(2)", [])
        .unwrap();
    let input = |id| {
        json!({"media":{"id":id,"idMal":id,"title":"Fixture title","cover":"","banner":null,
        "format":"TV","episodes":12},"status":"CURRENT"})
    };
    profile::request(root.path(), "library.setStatus", input(1)).unwrap();
    assert!(state::has_due(Some(&db), "anilist").unwrap());
    assert!(state::has_due(Some(&db), "mal").unwrap());
    profile::request(
        root.path(),
        "library.setScore",
        json!({"mediaId":1,"score":8.5}),
    )
    .unwrap();
    profile::request(root.path(), "library.toggleFavourite", input(1)).unwrap();
    profile::request(root.path(), "library.toggleFavourite", input(1)).unwrap();
    assert!(!state::queue_library(&db, 2, None).unwrap());
    crate::integrations::set_kv(&db, "settings", &json!({"accounts":{"autoSync":false}})).unwrap();
    profile::request(root.path(), "library.setStatus", input(3)).unwrap();

    let mut rows = db
        .prepare("SELECT dedupe_key FROM sync_queue ORDER BY dedupe_key")
        .unwrap();
    let keys = rows
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        keys,
        ["anilist:entry:1", "anilist:favourite:1", "mal:entry:1"]
    );
    assert_eq!(
        db.query_row(
            "SELECT json_extract(payload,'$.favourite') FROM sync_queue
        WHERE dedupe_key='anilist:favourite:1'",
            [],
            |row| row.get::<_, bool>(0)
        )
        .unwrap(),
        false
    );
    assert_eq!(
        db.query_row("SELECT score FROM library WHERE media_id=1", [], |row| row
            .get::<_, f64>(
            0
        ))
        .unwrap(),
        8.5
    );
    assert_eq!(
        db.query_row("SELECT status FROM library WHERE media_id=3", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "CURRENT"
    );
}

#[test]
fn account_status_records_only_the_affected_provider_and_preserves_credentials() {
    let cache = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/cache/aniverse2");
    std::fs::create_dir_all(&cache).unwrap();
    let root = tempfile::tempdir_in(cache).unwrap();
    let db = profile::writable(root.path()).unwrap();
    let original = json!({"token":"protected-fixture","lastSyncAt":100,"lastError":null});
    db.execute(
        "INSERT INTO accounts(provider,data) VALUES('anilist',?1),('mal',?1)",
        [original.to_string()],
    )
    .unwrap();

    state::sync_status(
        root.path(),
        "mal",
        None,
        Some("The service did not respond."),
    )
    .unwrap();
    let failed = read(Some(&db), "mal").unwrap();
    assert_eq!(failed["lastError"], "The service did not respond.");
    assert_eq!(failed["lastSyncAt"], 100);
    assert_eq!(failed["token"], "protected-fixture");
    assert_eq!(read(Some(&db), "anilist").unwrap(), original);

    state::sync_status(root.path(), "mal", Some(200), None).unwrap();
    let synced = read(Some(&db), "mal").unwrap();
    assert!(synced["lastError"].is_null());
    assert_eq!(synced["lastSyncAt"], 200);
    assert_eq!(synced["token"], "protected-fixture");
}
