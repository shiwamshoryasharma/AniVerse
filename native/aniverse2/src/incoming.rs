use aniverse_desktop_migration::{publish_profile_copy, VerifiedHandoff};
use serde_json::json;
use std::{
    ffi::OsStr,
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
    time::Duration,
};

const LEGACY_SQLITE_SCHEMA: u32 = 5;
const IMPORTED: &str = "profile-data";

pub(crate) fn data_root(root: &Path) -> io::Result<PathBuf> {
    let candidate = root.join(IMPORTED);
    match fs::symlink_metadata(&candidate) {
        Ok(meta) if meta.file_type().is_dir() => Ok(candidate),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid imported profile folder",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(root.to_path_buf()),
        Err(error) => Err(error),
    }
}

pub(crate) fn prepare(identifier: &str, marker: &OsStr) -> Result<(), Box<dyn std::error::Error>> {
    let (root, legacy) = roots(identifier)?;
    receive(marker, &root, &legacy)?;
    Ok(())
}

#[cfg(not(feature = "isolated-test"))]
fn roots(identifier: &str) -> Result<(PathBuf, PathBuf), Box<dyn std::error::Error>> {
    let roaming = dirs::data_dir().ok_or("missing Windows application data directory")?;
    Ok((roaming.join(identifier), roaming.join("AniVerse")))
}

#[cfg(feature = "isolated-test")]
fn roots(_: &str) -> Result<(PathBuf, PathBuf), Box<dyn std::error::Error>> {
    let root = crate::isolated_profile_path()?;
    let path = PathBuf::from(
        std::env::var_os("ANIVERSE2_TEST_LEGACY_PROFILE").ok_or("missing test source profile")?,
    )
    .canonicalize()?;
    if path.parent() != root.parent() || path.file_name().is_none_or(|name| name != "legacy") {
        return Err("the test source profile must be the isolated legacy fixture".into());
    }
    Ok((root, path))
}

fn receive(
    marker: &OsStr,
    root: &Path,
    legacy: &Path,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if data_root(root)? != root
        || root.join("aniverse.db").try_exists()?
        || root.join("profile.id").try_exists()?
        || root.join("config/streaming-sites.txt").try_exists()?
    {
        return Err("AniVerse2 already has a profile. The incoming copy was not applied.".into());
    }
    let executable = std::env::current_exe()?;
    let job = verify(Path::new(marker), legacy, &executable)?;
    fs::create_dir_all(root)?;
    let stage = job.stage_after_exit(
        root,
        LEGACY_SQLITE_SCHEMA,
        Duration::from_secs(30),
        Duration::from_secs(20),
    )?;
    let mut journal = File::create_new(stage.path().join("migration-stage.json"))?;
    let record = json!({"schema": 1, "nonce": job.nonce().to_string(), "state": "profile-copied"});
    journal.write_all(&serde_json::to_vec(&record)?)?;
    journal.sync_all()?;
    drop(journal);
    let target = root.join(IMPORTED);
    publish_profile_copy(stage, &target)?;
    Ok(target)
}

#[cfg(not(feature = "isolated-test"))]
fn verify(
    marker: &Path,
    legacy: &Path,
    executable: &Path,
) -> Result<VerifiedHandoff, Box<dyn std::error::Error>> {
    Ok(VerifiedHandoff::open(
        marker,
        legacy,
        executable,
        env!("CARGO_PKG_VERSION"),
    )?)
}

#[cfg(feature = "isolated-test")]
fn verify(
    marker: &Path,
    legacy: &Path,
    executable: &Path,
) -> Result<VerifiedHandoff, Box<dyn std::error::Error>> {
    let pin = std::env::var("ANIVERSE2_TEST_SIGNER_PIN")?;
    Ok(VerifiedHandoff::open_test_fixture(
        marker,
        legacy,
        executable,
        env!("CARGO_PKG_VERSION"),
        pin,
    )?)
}
