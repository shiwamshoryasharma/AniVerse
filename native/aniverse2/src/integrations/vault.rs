use base64::{engine::general_purpose::STANDARD, Engine};
use std::{io, mem::size_of, path::Path, ptr::null, ptr::null_mut};
use windows_sys::Win32::{Foundation::LocalFree, Security::Cryptography::*};

const MAX_SECRET: usize = 100_000;

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "The protected Windows credential is unavailable.",
    )
}

fn dpapi(bytes: &[u8], seal: bool) -> io::Result<Vec<u8>> {
    if bytes.is_empty() || bytes.len() > MAX_SECRET {
        return Err(invalid());
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let result = unsafe {
        if seal {
            CryptProtectData(
                &input,
                null(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                null_mut(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if result == 0 || output.pbData.is_null() {
        return Err(invalid());
    }
    let len = output.cbData as usize;
    let outcome = if len <= MAX_SECRET {
        Ok(unsafe { std::slice::from_raw_parts(output.pbData, len) }.to_vec())
    } else {
        Err(invalid())
    };
    unsafe {
        if !seal {
            std::ptr::write_bytes(output.pbData, 0, len);
        }
        LocalFree(output.pbData.cast());
    }
    outcome
}

fn profile_id(root: &Path) -> io::Result<String> {
    let id = crate::profile::text_file(&root.join("profile.id"), 100)?.ok_or_else(invalid)?;
    let id = id.trim();
    if id.len() != 32
        || !id
            .bytes()
            .all(|x| x.is_ascii_digit() || (b'a'..=b'f').contains(&x))
    {
        return Err(invalid());
    }
    Ok(id.to_owned())
}

pub(super) fn seal(root: &Path, data: &str) -> io::Result<String> {
    let file = root.join("profile.id");
    match profile_id(root) {
        Ok(_) => {}
        Err(_) if !file.try_exists()? => {
            use std::io::Write;
            let mut candidate = tempfile::NamedTempFile::new_in(root)?;
            candidate.write_all(uuid::Uuid::new_v4().simple().to_string().as_bytes())?;
            candidate.as_file().sync_all()?;
            match candidate.persist_noclobber(&file) {
                Ok(_) => {}
                Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.error),
            }
        }
        Err(error) => return Err(error),
    };
    let mut plaintext = format!("{}\n{data}", profile_id(root)?).into_bytes();
    let result = dpapi(&plaintext, true);
    plaintext.fill(0);
    Ok(format!("dpapi1:{}", STANDARD.encode(result?)))
}

pub(super) fn open(root: &Path, encoded: &str) -> io::Result<String> {
    let (version, data) = encoded.split_once(':').ok_or_else(invalid)?;
    if data.len() > MAX_SECRET * 2 {
        return Err(invalid());
    }
    let data = STANDARD.decode(data).map_err(|_| invalid())?;
    let decoded = match version {
        "dpapi1" => dpapi(&data, false)?,
        // Chromium Local State holds only a DPAPI-wrapped AES key. The migration
        // worker copies that one field separately from browser cookies and state.
        "enc2" if data.starts_with(b"v10") => {
            let wrapped =
                crate::profile::text_file(&root.join("chromium-encrypted-key.json"), 4096)?
                    .ok_or_else(invalid)?;
            let wrapped: String = serde_json::from_str(&wrapped).map_err(|_| invalid())?;
            let wrapped = STANDARD.decode(wrapped).map_err(|_| invalid())?;
            let mut key = dpapi(wrapped.strip_prefix(b"DPAPI").ok_or_else(invalid)?, false)?;
            let result = chromium(&key, &data[3..]);
            key.fill(0);
            result?
        }
        // Earlier profile-bound Electron versions may have used direct DPAPI.
        "enc2" => dpapi(&data, false)?,
        _ => return Err(invalid()),
    };
    let mut decoded = String::from_utf8(decoded).map_err(|_| invalid())?;
    let bound = format!("{}\n", profile_id(root)?);
    let result = decoded
        .strip_prefix(&bound)
        .filter(|x| !x.is_empty())
        .map(str::to_owned);
    // Keep zeroing in-memory byte vectors confined to this native vault.
    unsafe { decoded.as_bytes_mut().fill(0) };
    result.ok_or_else(invalid)
}

fn chromium(key: &[u8], ciphertext: &[u8]) -> io::Result<Vec<u8>> {
    if key.len() != 32 || !(29..=MAX_SECRET).contains(&ciphertext.len()) {
        return Err(invalid());
    }
    let (nonce, rest) = ciphertext.split_at(12);
    let (encrypted, tag) = rest.split_at(rest.len() - 16);
    let mut nonce = <[u8; 12]>::try_from(nonce).unwrap();
    let mut tag = <[u8; 16]>::try_from(tag).unwrap();
    let mut result = vec![0; encrypted.len()];
    let mut written = 0;
    let mut handle = null_mut();
    // BCrypt allocates the key object on Windows 10+ when its object buffer is omitted.
    let initialise = unsafe {
        BCryptGenerateSymmetricKey(
            BCRYPT_AES_GCM_ALG_HANDLE,
            &mut handle,
            null_mut(),
            0,
            key.as_ptr(),
            32,
            0,
        )
    };
    if initialise < 0 {
        return Err(invalid());
    }
    let auth = BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO {
        cbSize: size_of::<BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO>() as u32,
        dwInfoVersion: BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO_VERSION,
        pbNonce: nonce.as_mut_ptr(),
        cbNonce: 12,
        pbTag: tag.as_mut_ptr(),
        cbTag: 16,
        ..Default::default()
    };
    let decrypt = unsafe {
        let status = BCryptDecrypt(
            handle,
            encrypted.as_ptr(),
            encrypted.len() as u32,
            (&auth as *const BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO).cast(),
            null_mut(),
            0,
            result.as_mut_ptr(),
            result.len() as u32,
            &mut written,
            0,
        );
        BCryptDestroyKey(handle);
        status
    };
    if decrypt < 0 || written as usize != result.len() {
        result.fill(0);
        return Err(invalid());
    }
    Ok(result)
}
