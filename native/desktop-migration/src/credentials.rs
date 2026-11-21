use crate::profile::open_regular;
use std::{
    fs::File,
    io::{self, Read, Write},
    path::Path,
};

const MAX_STATE_BYTES: u64 = 16 * 1024 * 1024;

/// Keep only the encrypted same-user key Chromium uses for legacy tokens.
/// The original Local State, browsing data and decrypted tokens stay out of the copy.
pub(crate) fn stage_encrypted_key(data: &Path, target: &Path) -> io::Result<()> {
    let state = match open_regular(&data.join("Local State")) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    state.take(MAX_STATE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err(invalid_key());
    }
    let first = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    let state: serde_json::Value = serde_json::from_slice(first)?;
    let key = &state["os_crypt"]["encrypted_key"];
    if key.is_null() {
        return Ok(());
    }
    let key = key
        .as_str()
        .filter(|key| {
            !key.is_empty()
                && key.len() <= 4096
                && key
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
        })
        .ok_or_else(invalid_key)?;
    let mut output = File::create_new(target.join("chromium-encrypted-key.json"))?;
    serde_json::to_writer(&mut output, key)?;
    output.flush()?;
    output.sync_all()
}

fn invalid_key() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "the legacy encrypted credential key is unreadable",
    )
}
