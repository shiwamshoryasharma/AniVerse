use aniverse_desktop_migration::{stage_database, SnapshotError};
use rusqlite::Connection;
use std::{env, fs, path::PathBuf, time::Duration};

const TIMEOUT: Duration = Duration::from_secs(5);

fn fixture() -> tempfile::TempDir {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/cache/tauri-compat/staging-fixtures");
    fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root).unwrap()
}

#[test]
fn preserves_committed_wal_content_and_leaves_writer_and_its_uncommitted_row_alone() {
    let folder = fixture();
    let source = folder.path().join("legacy.sqlite");
    let target = folder.path().join("staged.sqlite");
    let legacy = Connection::open(&source).unwrap();
    legacy
        .execute_batch(
            "
        PRAGMA journal_mode=WAL;
        PRAGMA wal_autocheckpoint=0;
        PRAGMA user_version=7;
        CREATE TABLE data (value TEXT NOT NULL);
        INSERT INTO data VALUES ('saved');
        BEGIN IMMEDIATE;
        INSERT INTO data VALUES ('uncommitted');
    ",
        )
        .unwrap();
    assert!(source.with_file_name("legacy.sqlite-wal").exists());
    stage_database(&source, &target, 7, TIMEOUT).unwrap();
    let copy = Connection::open(&target).unwrap();
    let count = copy
        .query_row(
            "SELECT count(*) FROM data WHERE value = 'saved'",
            [],
            |row| row.get::<_, u32>(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    let count = copy
        .query_row("SELECT count(*) FROM data", [], |row| row.get::<_, u32>(0))
        .unwrap();
    assert_eq!(count, 1);
    assert!(!legacy.is_autocommit());
    legacy
        .execute_batch("ROLLBACK; INSERT INTO data VALUES ('writer still works');")
        .unwrap();
}

#[test]
fn rejects_unknown_schema_without_publishing_anything() {
    let folder = fixture();
    let source = folder.path().join("legacy.sqlite");
    let target = folder.path().join("staged.sqlite");
    let db = Connection::open(&source).unwrap();
    db.execute_batch("PRAGMA user_version=8; CREATE TABLE example (data TEXT);")
        .unwrap();
    assert!(matches!(
        stage_database(&source, &target, 7, TIMEOUT),
        Err(SnapshotError::WrongSchema {
            expected: 7,
            found: 8
        })
    ));
    assert!(!target.exists());
    assert!(!fs::read_dir(folder.path()).unwrap().any(|f| f
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".aniverse-db-")));
}

#[test]
fn rejects_retry_over_an_existing_staged_database() {
    let folder = fixture();
    let source = folder.path().join("legacy.sqlite");
    let target = folder.path().join("staged.sqlite");
    let db = Connection::open(&source).unwrap();
    db.execute_batch("PRAGMA user_version=7; CREATE TABLE example (data TEXT);")
        .unwrap();
    fs::write(&target, b"keep the existing file").unwrap();
    assert!(
        matches!(stage_database(&source, &target, 7, TIMEOUT), Err(SnapshotError::Filesystem(e)) if e.kind()==std::io::ErrorKind::AlreadyExists)
    );
    assert_eq!(fs::read(&target).unwrap(), b"keep the existing file");
}

#[test]
fn backup_deadline_publishes_no_target() {
    let folder = fixture();
    let source = folder.path().join("legacy.sqlite");
    let target = folder.path().join("staged.sqlite");
    let _db = Connection::open(&source).unwrap();
    assert!(matches!(
        stage_database(&source, &target, 0, Duration::ZERO),
        Err(SnapshotError::BackupDeadline)
    ));
    assert!(!target.exists());
}
