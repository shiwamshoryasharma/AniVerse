use crate::{proof, release_signature::SignedRelease, stage_profile, ProfileProof, SnapshotError};
use semver::Version;
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    fs::File,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

const PREFERENCES: &[&str] = &[
    "aniverse.rail",
    "aniverse.desktop-theme",
    "aniverse.historyView",
    "aniverse.scheduleView",
    "aniverse.latestSeen",
];

#[derive(Debug, thiserror::Error)]
pub enum HandoffError {
    #[error("the Electron handoff contains invalid or unsupported data")]
    Invalid,
    #[error("the migration release signature is invalid")]
    Signature,
    #[error("the Electron process is still running")]
    LegacyStillRunning,
    #[error("the Electron process does not match the handoff's executable")]
    LegacyProcessMismatch,
    #[error("the installed AniVerse2 executable does not match the signed release")]
    ApplicationHash,
    #[error(transparent)]
    Read(#[from] io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Snapshot(#[from] SnapshotError),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Descriptor {
    schema: u32,
    nonce: Uuid,
    legacy_pid: u32,
    legacy_version: String,
    legacy_executable: PathBuf,
    data_dir: PathBuf,
    config_dir: PathBuf,
    preferences: BTreeMap<String, String>,
    signed_release: SignedRelease,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema: u32,
    role: String,
    target: String,
    version: String,
    minimum_electron: String,
    installer_sha256: String,
    installer_bytes: u64,
    application_sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Publisher {
    update_signers: Vec<String>,
}

/// Input to the native installer coordinator after checking the signed release and candidate executable.
/// The legacy PID and path are metadata for the coordinator's process and uninstall checks.
pub struct VerifiedHandoff(Descriptor, String);

impl VerifiedHandoff {
    pub fn open(
        marker: &Path,
        legacy_profile: &Path,
        application: &Path,
        application_version: &str,
    ) -> Result<Self, HandoffError> {
        let policy: Publisher = serde_json::from_str(include_str!("../../../config/signing.json"))?;
        verify(
            marker,
            legacy_profile,
            application,
            application_version,
            &policy.update_signers,
        )
    }

    #[cfg(feature = "test-signers")]
    #[doc(hidden)]
    pub fn open_test_fixture(
        marker: &Path,
        legacy_profile: &Path,
        application: &Path,
        version: &str,
        pin: String,
    ) -> Result<Self, HandoffError> {
        verify(marker, legacy_profile, application, version, &[pin])
    }

    pub fn legacy_process(&self) -> (u32, &Path) {
        (self.0.legacy_pid, &self.0.legacy_executable)
    }

    pub fn nonce(&self) -> Uuid {
        self.0.nonce
    }

    pub fn profile_proof(&self, root: &Path) -> Result<ProfileProof, HandoffError> {
        Ok(ProfileProof::capture(root, self.nonce(), &self.1)?)
    }

    /// Run on the installer worker. The coordinator must still prevent Electron
    /// from being relaunched during final promotion. This only stages a copy.
    pub fn stage_after_exit(
        &self,
        parent: &Path,
        sqlite_schema: u32,
        exit_timeout: Duration,
        backup_timeout: Duration,
    ) -> Result<tempfile::TempDir, HandoffError> {
        let job = &self.0;
        crate::legacy_process::wait_for_legacy_exit(
            job.legacy_pid,
            &job.legacy_executable,
            exit_timeout,
        )?;
        let profile = stage_profile(
            &job.data_dir,
            &job.config_dir,
            parent,
            sqlite_schema,
            backup_timeout,
        )?;
        let mut preferences = File::create_new(profile.path().join("renderer-preferences.json"))?;
        preferences.write_all(&serde_json::to_vec(&job.preferences)?)?;
        preferences.sync_all()?;
        Ok(profile)
    }
}

fn verify(
    marker: &Path,
    legacy_profile: &Path,
    application: &Path,
    application_version: &str,
    pins: &[String],
) -> Result<VerifiedHandoff, HandoffError> {
    let marker = marker.canonicalize()?;
    let legacy_profile = legacy_profile.canonicalize()?;
    let relative = marker
        .strip_prefix(&legacy_profile)
        .map_err(|_| HandoffError::Invalid)?;
    let path: Vec<_> = relative.iter().map(|part| part.to_str()).collect();
    if !matches!(path.as_slice(), [Some("windows-migration"), Some(attempt), Some("electron-handoff.json")] if attempt.starts_with("attempt-"))
    {
        return Err(HandoffError::Invalid);
    }
    let mut bytes = Vec::new();
    File::open(marker)?.take(65_537).read_to_end(&mut bytes)?;
    if bytes.len() > 65_536 {
        return Err(HandoffError::Invalid);
    }

    let mut job: Descriptor = serde_json::from_slice(&bytes)?;
    if job.schema != 1
        || job.nonce.get_version_num() != 4
        || job.legacy_pid == 0
        || !job.legacy_executable.is_absolute()
        || !job
            .legacy_executable
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("AniVerse.exe"))
        || !job.data_dir.is_absolute()
        || job.data_dir.canonicalize()? != legacy_profile
        || !job.config_dir.is_absolute()
        || job.preferences.iter().any(|(key, value)| {
            !PREFERENCES.contains(&key.as_str()) || value.encode_utf16().count() > 128
        })
    {
        return Err(HandoffError::Invalid);
    }
    job.data_dir = legacy_profile;
    job.config_dir = job.config_dir.canonicalize()?;
    let payload: Manifest = serde_json::from_slice(&job.signed_release.verify(pins)?)?;
    let current = stable_version(&job.legacy_version)?;
    let target = stable_version(application_version)?;
    let minimum = stable_version(&payload.minimum_electron)?;
    let valid_hash = |text: &str| {
        text.len() == 64
            && text
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    if payload.schema != 1
        || payload.role != "aniverse-tauri-migration"
        || payload.target != "windows-x64"
        || stable_version(&payload.version)? != target
        || minimum > current
        || target <= current
        || !valid_hash(&payload.installer_sha256)
        || !valid_hash(&payload.application_sha256)
        || !(1..=2_000_000_000).contains(&payload.installer_bytes)
    {
        return Err(HandoffError::Invalid);
    }
    if proof::file_hash(application)? != payload.application_sha256 {
        return Err(HandoffError::ApplicationHash);
    }
    Ok(VerifiedHandoff(job, payload.application_sha256))
}

fn stable_version(text: &str) -> Result<Version, HandoffError> {
    if text
        .split('.')
        .any(|part| part.is_empty() || part.len() > 9 || !part.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(HandoffError::Invalid);
    }
    Version::parse(text).map_err(|_| HandoffError::Invalid)
}

#[cfg(test)]
#[path = "../../../test/tauri-compat/handoff.rs"]
mod tests;
