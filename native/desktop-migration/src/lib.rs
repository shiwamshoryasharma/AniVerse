//! Verified copies for the desktop handoff. The legacy app and profile remain
//! intact throughout staging.
#[cfg(target_os = "windows")]
mod credentials;
#[cfg(target_os = "windows")]
mod handoff;
#[cfg(target_os = "windows")]
mod legacy_process;
mod profile;
#[cfg(target_os = "windows")]
mod profile_publish;
#[cfg(target_os = "windows")]
mod proof;
#[cfg(target_os = "windows")]
mod release_signature;
#[cfg(target_os = "windows")]
pub use handoff::{HandoffError, VerifiedHandoff};
#[cfg(target_os = "windows")]
pub use proof::ProfileProof;

pub use profile::stage_profile;
#[cfg(target_os = "windows")]
pub use profile_publish::publish_profile_copy;

use rusqlite::{
    backup::{Backup, StepResult},
    Connection, OpenFlags,
};
use std::{
    fs::{self, OpenOptions},
    io,
    path::Path,
    time::{Duration, Instant},
};

#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
    #[error("snapshot destination needs an existing staging directory")]
    MissingStagingDirectory,
    #[error("expected SQLite schema {expected}, found {found}")]
    WrongSchema { expected: u32, found: u32 },
    #[error("SQLite integrity check did not report ok")]
    IntegrityCheck,
    #[error("SQLite snapshot did not finish within the backup deadline")]
    BackupDeadline,
    #[error("cannot expose a snapshot that still has a SQLite sidecar")]
    UncheckpointedSnapshot,
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Filesystem(#[from] io::Error),
}

/// Stage a consistent snapshot, including committed WAL pages.
///
/// Run this on a worker thread. The caller owns the destination directory and
/// has quiesced Electron writers before the final cutover. This is a database
/// snapshot only. Encrypted account rows stay encrypted; decryption and
/// profile validation belong to a separate part of the migration.
pub fn stage_database(
    source: &Path,
    destination: &Path,
    expected_schema: u32,
    backup_timeout: Duration,
) -> Result<(), SnapshotError> {
    let parent = destination
        .parent()
        .filter(|p| p.is_dir())
        .ok_or(SnapshotError::MissingStagingDirectory)?;
    profile::require_regular(source)?;
    let original = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    original.busy_timeout(Duration::from_millis(100))?;
    original.execute_batch("PRAGMA trusted_schema=OFF; BEGIN DEFERRED;")?;
    let original_version =
        original.query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))?;
    if original_version != expected_schema {
        return Err(SnapshotError::WrongSchema {
            expected: expected_schema,
            found: original_version,
        });
    }
    let temporary = tempfile::Builder::new()
        .prefix(".aniverse-db-")
        .tempdir_in(parent)?;
    let staged_file = temporary.path().join("snapshot.sqlite");
    let mut staged = Connection::open(&staged_file)?;
    staged.busy_timeout(Duration::from_millis(100))?;
    staged.pragma_update(None, "trusted_schema", false)?;

    {
        let start = Instant::now();
        let backup = Backup::new(&original, &mut staged)?;
        loop {
            if start.elapsed() >= backup_timeout {
                return Err(SnapshotError::BackupDeadline);
            }
            match backup.step(128)? {
                StepResult::Done => break,
                StepResult::More => {}
                _ => std::thread::sleep(Duration::from_millis(20)),
            }
        }
    }

    let version = staged.query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))?;
    if version != expected_schema {
        return Err(SnapshotError::WrongSchema {
            expected: expected_schema,
            found: version,
        });
    }
    let integrity = staged.query_row("PRAGMA quick_check(1)", [], |row| row.get::<_, String>(0))?;
    if integrity != "ok" {
        return Err(SnapshotError::IntegrityCheck);
    }
    let mode = staged.query_row("PRAGMA journal_mode = DELETE", [], |row| {
        row.get::<_, String>(0)
    })?;
    staged.close().map_err(|(_, error)| error)?;
    if !mode.eq_ignore_ascii_case("delete")
        || [
            "snapshot.sqlite-wal",
            "snapshot.sqlite-shm",
            "snapshot.sqlite-journal",
        ]
        .iter()
        .any(|name| temporary.path().join(name).exists())
    {
        return Err(SnapshotError::UncheckpointedSnapshot);
    }
    OpenOptions::new()
        .write(true)
        .open(&staged_file)?
        .sync_all()?;
    // Publishing within the same volume by hard link fails if anything already
    // owns the destination. Never replace an existing database, even on retry.
    fs::hard_link(staged_file, destination)?;
    Ok(())
}
