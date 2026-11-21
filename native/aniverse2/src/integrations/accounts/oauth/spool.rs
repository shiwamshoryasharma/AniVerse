use super::{Callback, TTL};
use crate::{integrations::vault, profile, RpcError};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    fs,
    io::{self, Write},
    os::windows::{ffi::OsStringExt, fs::MetadataExt},
    path::{Path, PathBuf},
    ptr::null_mut,
};
use windows_sys::{
    core::w,
    Win32::{
        System::Com::CoTaskMemFree,
        UI::Shell::{
            AssocQueryStringW, FOLDERID_RoamingAppData, SHGetKnownFolderPath, ASSOCF_IS_PROTOCOL,
            ASSOCSTR_COMMAND,
        },
    },
};

const RESPONSE_LIMIT: usize = 65_536;
const PATH_LIMIT: usize = 32_768;
const REPARSE_POINT: u32 = 0x0400;

pub(super) struct Ticket {
    spool: PathBuf,
    pending: PathBuf,
    accepted: PathBuf,
    consumed: bool,
}

impl Ticket {
    pub(super) fn new(root: &Path, provider: &str, state: &str) -> io::Result<Self> {
        let spool = folder(root, true)?;
        let (pending, accepted) = names(&spool, state);
        let mut marker = tempfile::NamedTempFile::new_in(&spool)?;
        let expires = chrono::Utc::now().timestamp() + TTL.as_secs() as i64;
        writeln!(marker, "{provider}\n{expires}")?;
        marker.as_file().sync_all()?;
        marker
            .persist_noclobber(&pending)
            .map_err(|err| err.error)?;
        Ok(Self {
            spool,
            pending,
            accepted,
            consumed: false,
        })
    }

    pub(super) fn response(&mut self) -> io::Result<Option<String>> {
        if self.consumed {
            return Ok(None);
        }
        let Some(encrypted) = read_file(&self.accepted, RESPONSE_LIMIT)? else {
            return Ok(None);
        };
        self.consumed = true;
        vault::open(&self.spool, &encrypted).map(Some)
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        for path in [&self.pending, &self.accepted] {
            let _ = fs::remove_file(path);
        }
    }
}

pub(super) fn deliver(root: &Path, callback: &Callback, raw: &str) -> io::Result<()> {
    let spool = folder(root, false)?;
    let (pending, accepted) = names(&spool, &callback.state);
    let marker = read_file(&pending, 128)?.ok_or_else(invalid)?;
    let (provider, expiry) = marker.trim_end().split_once('\n').ok_or_else(invalid)?;
    let expires = expiry.parse::<i64>().map_err(|_| invalid())?;
    let now = chrono::Utc::now().timestamp();
    if provider != callback.provider || !(now..=now + TTL.as_secs() as i64).contains(&expires) {
        return Err(invalid());
    }
    let encrypted = vault::seal(&spool, raw)?;
    let mut response = tempfile::NamedTempFile::new_in(&spool)?;
    response.write_all(encrypted.as_bytes())?;
    response.as_file().sync_all()?;
    response
        .persist_noclobber(&accepted)
        .map_err(|err| err.error)?;
    // Cancellation may have removed the attempt while the credential was sealed.
    if read_file(&pending, 128)?.as_ref() != Some(&marker) {
        let _ = fs::remove_file(&accepted);
        return Err(invalid());
    }
    Ok(())
}

fn folder(root: &Path, create: bool) -> io::Result<PathBuf> {
    let root = root.canonicalize()?;
    let path = root.join("oauth-callbacks");
    if create {
        match fs::create_dir(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {}
            Err(err) => return Err(err),
        }
    }
    let meta = fs::symlink_metadata(&path)?;
    if !meta.is_dir()
        || meta.file_attributes() & REPARSE_POINT != 0
        || path.canonicalize()?.parent() != Some(&root)
    {
        return Err(invalid());
    }
    Ok(path)
}

fn names(spool: &Path, state: &str) -> (PathBuf, PathBuf) {
    let digest: String = Sha256::digest(state.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    (
        spool.join(format!("{digest}.pending")),
        spool.join(format!("{digest}.response")),
    )
}

fn read_file(path: &Path, limit: usize) -> io::Result<Option<String>> {
    let info = match fs::symlink_metadata(path) {
        Ok(info) => info,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    if !info.is_file() || info.file_attributes() & REPARSE_POINT != 0 || info.len() > limit as u64 {
        return Err(invalid());
    }
    profile::text_file(path, limit)
}

pub(super) fn owns_scheme() -> bool {
    if cfg!(feature = "isolated-test") {
        return false;
    }
    let Ok(current) = std::env::current_exe() else {
        return false;
    };
    let mut command = [0u16; PATH_LIMIT];
    let mut size = command.len() as u32;
    let result = unsafe {
        AssocQueryStringW(
            ASSOCF_IS_PROTOCOL,
            ASSOCSTR_COMMAND,
            w!("aniverse2"),
            w!("open"),
            command.as_mut_ptr(),
            &mut size,
        )
    };
    if result != 0 || size == 0 || size as usize > command.len() {
        return false;
    }
    let Some(end) = command.iter().position(|word| *word == 0) else {
        return false;
    };
    let Ok(command) = String::from_utf16(&command[..end]) else {
        return false;
    };
    owner_command(&command, &current)
}

pub(super) fn owner_command(command: &str, exe: &Path) -> bool {
    let Some((program, args)) = command
        .strip_prefix('"')
        .and_then(|command| command.split_once('"'))
    else {
        return false;
    };
    let binary = Path::new(program);
    if !binary.is_absolute() || args != " --oauth-callback \"%1\"" {
        return false;
    }
    let (Ok(program), Ok(exe)) = (binary.canonicalize(), exe.canonicalize()) else {
        return false;
    };
    program == exe
}

pub(super) fn roaming_root(identifier: &str) -> io::Result<PathBuf> {
    if identifier.len() > 100
        || !identifier.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
    {
        return Err(invalid());
    }
    let mut assigned = null_mut();
    let status =
        unsafe { SHGetKnownFolderPath(&FOLDERID_RoamingAppData, 0, null_mut(), &mut assigned) };
    if status != 0 || assigned.is_null() {
        return Err(invalid());
    }
    let path = unsafe {
        let end = (0..PATH_LIMIT).find(|offset| *assigned.add(*offset) == 0);
        let path = end.map(|len| OsString::from_wide(std::slice::from_raw_parts(assigned, len)));
        CoTaskMemFree(assigned.cast());
        path
    }
    .ok_or_else(invalid)?;
    Ok(PathBuf::from(path).join(identifier))
}

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "The native account callback was invalid.",
    )
}

pub(super) fn error() -> RpcError {
    RpcError::new(
        "unavailable",
        "AniVerse2 could not receive the account callback.",
    )
}
