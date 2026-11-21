use crate::profile::{open_regular, PROFILE_FILES};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{self, Read, Write},
    path::Path,
};
use uuid::Uuid;

const GENERATED: &[&str] = &[
    "aniverse.db",
    "renderer-preferences.json",
    "chromium-encrypted-key.json",
    "migration-stage.json",
];

/// Verification state stays in the signed installer worker across the atomic
/// move. The disk record is diagnostic and never authorizes uninstallation.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct ProfileProof {
    schema: u32,
    nonce: Uuid,
    application_sha256: String,
    files: BTreeMap<&'static str, String>,
}

impl ProfileProof {
    const FILE: &'static str = "migration-inventory.json";
    const VERIFIED: &'static str = "migration-copy-verified";

    pub(crate) fn capture(root: &Path, nonce: Uuid, application_sha256: &str) -> io::Result<Self> {
        let mut files = BTreeMap::new();
        for file in PROFILE_FILES
            .iter()
            .map(|entry| entry.path)
            .chain(GENERATED.iter().copied())
        {
            match file_hash(&root.join(file)) {
                Ok(hash) => {
                    files.insert(file, hash);
                }
                Err(error)
                    if error.kind() == io::ErrorKind::NotFound
                        && !matches!(
                            file,
                            "aniverse.db"
                                | "config/streaming-sites.txt"
                                | "profile.id"
                                | "renderer-preferences.json"
                                | "migration-stage.json"
                        ) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(Self {
            schema: 1,
            nonce,
            application_sha256: application_sha256.to_owned(),
            files,
        })
    }

    pub fn write_inventory(&self, root: &Path) -> io::Result<()> {
        let mut file = File::create_new(root.join(Self::FILE))?;
        serde_json::to_writer(&mut file, self)?;
        file.flush()?;
        file.sync_all()
    }

    /// Compare the exact published data against the verification state held by
    /// the worker, including the expected absence of optional files.
    pub fn verify(&self, root: &Path) -> io::Result<()> {
        let actual = Self::capture(root, self.nonce, &self.application_sha256)?;
        let expected = serde_json::to_vec(self)?;
        let mut bytes = Vec::new();
        open_regular(&root.join(Self::FILE))?
            .take(expected.len() as u64 + 1)
            .read_to_end(&mut bytes)?;
        if *self != actual || bytes != expected {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "migrated profile verification failed",
            ));
        }
        Ok(())
    }

    /// Seal the verified filesystem copy after publication succeeds. This is
    /// a data-copy receipt and carries no authority to remove the legacy app.
    pub fn complete(&self, root: &Path) -> io::Result<()> {
        self.verify(root)?;
        let inventory = hex::encode(Sha256::digest(serde_json::to_vec(self)?));
        let mut stamp = File::create_new(root.join(Self::VERIFIED))?;
        stamp.write_all(inventory.as_bytes())?;
        stamp.sync_all()
    }

    /// Profiles migrated by older versions have neither verification file.
    /// A new profile with partial or corrupt verification stays unavailable.
    pub fn validate_completion(root: &Path, required: bool) -> io::Result<()> {
        let mut inventory = Vec::new();
        let read = open_regular(&root.join(Self::FILE))
            .and_then(|file| file.take(8_193).read_to_end(&mut inventory));
        let digest = match read {
            Ok(1..=8_192) => hex::encode(Sha256::digest(&inventory)),
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "the profile inventory has an invalid size",
                ))
            }
            Err(error)
                if error.kind() == io::ErrorKind::NotFound
                    && !required
                    && !root.join(Self::VERIFIED).try_exists()? =>
            {
                return Ok(())
            }
            Err(error) => return Err(error),
        };
        let mut stamp = Vec::new();
        open_regular(&root.join(Self::VERIFIED))?
            .take(65)
            .read_to_end(&mut stamp)?;
        if stamp != digest.as_bytes() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "the saved profile-copy receipt is invalid",
            ));
        }
        Ok(())
    }
}

pub(crate) fn file_hash(path: &Path) -> io::Result<String> {
    let mut file = open_regular(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 65_536];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()))
}
