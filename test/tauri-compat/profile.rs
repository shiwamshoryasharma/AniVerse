use aniverse_desktop_migration::stage_profile;
use rusqlite::Connection;
use std::{env, fs, path::PathBuf, time::Duration};

fn fixture() -> (tempfile::TempDir, Connection) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/cache/tauri-compat/staging-fixtures");
    fs::create_dir_all(&root).unwrap();
    let folder = tempfile::tempdir_in(root).unwrap();
    let data = folder.path().join("electron");
    fs::create_dir_all(data.join("profile")).unwrap();
    let database = Connection::open(data.join("aniverse.db")).unwrap();
    database
        .execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA user_version=7;
         CREATE TABLE settings (name TEXT, value TEXT);
         INSERT INTO settings VALUES ('downloadFolder', 'D:/AniVerse Videos');",
        )
        .unwrap();
    fs::write(data.join("profile.id"), "fixture-identity").unwrap();
    (folder, database)
}

#[test]
fn stages_saved_sources_byte_for_byte_from_the_active_external_config() {
    let (folder, _database) = fixture();
    let data = folder.path().join("electron");
    let fallback = data.join("config");
    let active = folder.path().join("custom config");
    fs::create_dir(&fallback).unwrap();
    fs::create_dir(&active).unwrap();
    fs::write(fallback.join("streaming-sites.txt"), b"# inactive").unwrap();
    let sources = "\u{feff}# Saved comment あ\r\n\r\n1. https://fixture.test/sub\r\nhttps://fixture.test/dub\r\n";
    fs::write(active.join("streaming-sites.txt"), sources).unwrap();
    let profile = stage_profile(&data, &active, folder.path(), 7, Duration::from_secs(5)).unwrap();
    assert_eq!(
        fs::read(profile.path().join("config/streaming-sites.txt")).unwrap(),
        sources.as_bytes()
    );
    assert_eq!(
        fs::read(active.join("streaming-sites.txt")).unwrap(),
        sources.as_bytes()
    );
    assert_eq!(
        fs::read(fallback.join("streaming-sites.txt")).unwrap(),
        b"# inactive"
    );
}

#[test]
fn keeps_app_files_and_database_settings_without_copying_browser_data() {
    let (folder, _database) = fixture();
    let data = folder.path().join("electron");
    let config = data.join("config");
    fs::create_dir(&config).unwrap();
    fs::write(config.join("streaming-sites.txt"), b"").unwrap();
    fs::write(config.join("site-recipes.json"), b"{}").unwrap();
    fs::write(config.join("filters.txt"), b"! user filter\r\n").unwrap();
    fs::write(data.join("graphics.json"), b"{}").unwrap();
    fs::write(data.join("adblock-engine.bin"), b"compatible cache fixture").unwrap();
    fs::write(data.join("profile/avatar.png"), b"avatar fixture").unwrap();
    fs::create_dir(data.join("Partitions")).unwrap();
    fs::write(data.join("Partitions/Cookies"), b"excluded").unwrap();
    let profile = stage_profile(&data, &config, folder.path(), 7, Duration::from_secs(5)).unwrap();
    let staged = profile.path();
    for (path, expected) in [
        ("config/streaming-sites.txt", &b""[..]),
        ("config/site-recipes.json", b"{}"),
        ("config/filters.txt", b"! user filter\r\n"),
        ("graphics.json", b"{}"),
        ("adblock-engine.bin", b"compatible cache fixture"),
        ("profile.id", b"fixture-identity"),
        ("profile/avatar.png", b"avatar fixture"),
    ] {
        assert_eq!(fs::read(staged.join(path)).unwrap(), expected, "{path}");
    }
    assert!(!staged.join("Partitions").exists());
    let copied = Connection::open(staged.join("aniverse.db")).unwrap();
    let download: String = copied
        .query_row("SELECT value FROM settings", [], |row| row.get(0))
        .unwrap();
    assert_eq!(download, "D:/AniVerse Videos");
}

#[test]
fn fails_closed_if_active_sources_are_missing_and_leaves_no_partial_profile() {
    let (folder, _database) = fixture();
    let data = folder.path().join("electron");
    assert!(stage_profile(
        &data,
        folder.path(),
        folder.path(),
        7,
        Duration::from_secs(5)
    )
    .is_err());
    assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1);
    assert_eq!(
        fs::read(data.join("profile.id")).unwrap(),
        b"fixture-identity"
    );
}

#[test]
fn discards_partial_profile_after_database_verification_fails() {
    let (folder, _database) = fixture();
    let data = folder.path().join("electron");
    let config = data.join("config");
    fs::create_dir(&config).unwrap();
    let sources = config.join("streaming-sites.txt");
    fs::write(&sources, b"https://fixture.test/\r\n").unwrap();
    assert!(matches!(
        stage_profile(&data, &config, folder.path(), 8, Duration::from_secs(5)),
        Err(aniverse_desktop_migration::SnapshotError::WrongSchema {
            expected: 8,
            found: 7
        })
    ));
    assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1);
    assert_eq!(fs::read(sources).unwrap(), b"https://fixture.test/\r\n");
}

#[cfg(target_os = "windows")]
#[test]
fn concurrent_imports_can_publish_only_one_profile() {
    use aniverse_desktop_migration::publish_profile_copy;
    use std::sync::{Arc, Barrier};

    let (folder, _database) = fixture();
    let destination = folder.path().join("destination");
    let barrier = Arc::new(Barrier::new(2));
    let runners: Vec<_> = [b"first".as_slice(), b"second".as_slice()]
        .into_iter()
        .map(|content| {
            let stage = tempfile::tempdir_in(folder.path()).unwrap();
            fs::write(stage.path().join("sentinel.txt"), content).unwrap();
            let destination = destination.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                (content, publish_profile_copy(stage, &destination))
            })
        })
        .collect();
    let statuses: Vec<_> = runners
        .into_iter()
        .map(|runner| runner.join().unwrap())
        .collect();
    let winners: Vec<_> = statuses
        .iter()
        .filter(|(_, result)| result.is_ok())
        .collect();
    assert_eq!(winners.len(), 1);
    assert_eq!(
        fs::read(destination.join("sentinel.txt")).unwrap(),
        winners[0].0
    );
}
