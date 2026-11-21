use crate::{stage_database, SnapshotError};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek},
    path::Path,
    time::Duration,
};

pub(crate) struct ProfileFile {
    pub(crate) path: &'static str,
    required: bool,
}

const fn file(path: &'static str, required: bool) -> ProfileFile {
    ProfileFile { path, required }
}

pub(crate) const PROFILE_FILES: &[ProfileFile] = &[
    file("config/streaming-sites.txt", true),
    file("config/filters.txt", false),
    file("config/site-recipes.json", false),
    file("profile.id", true),
    file("graphics.json", false),
    file("adblock-engine.bin", false),
    file("profile/avatar.png", false),
    file("profile/avatar.jpg", false),
    file("profile/avatar.jpeg", false),
    file("profile/avatar.webp", false),
    file("profile/banner.png", false),
    file("profile/banner.jpg", false),
    file("profile/banner.jpeg", false),
    file("profile/banner.webp", false),
];

/// Build a disposable profile using Electron's actual config directory, which
/// may be portable or externally configured. The owner quiesces Electron first.
pub fn stage_profile(
    data: &Path,
    config: &Path,
    parent: &Path,
    expected_schema: u32,
    timeout: Duration,
) -> Result<tempfile::TempDir, SnapshotError> {
    let staged = tempfile::Builder::new()
        .prefix(".aniverse-profile-")
        .tempdir_in(parent)?;
    let target = staged.path();
    fs::create_dir(target.join("config"))?;
    fs::create_dir(target.join("profile"))?;
    for entry in PROFILE_FILES {
        let source = match entry.path.strip_prefix("config/") {
            Some(name) => config.join(name),
            None => data.join(entry.path),
        };
        copy(&source, &target.join(entry.path), entry.required)?;
    }
    #[cfg(windows)]
    crate::credentials::stage_encrypted_key(data, target)?;
    stage_database(
        &data.join("aniverse.db"),
        &target.join("aniverse.db"),
        expected_schema,
        timeout,
    )?;
    Ok(staged)
}

pub(crate) fn require_regular(path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        let meta = fs::symlink_metadata(parent)?;
        if !meta.is_dir() || linked(&meta) {
            return Err(invalid_file());
        }
    }
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file() || linked(&meta) {
        return Err(invalid_file());
    }
    Ok(())
}

pub(crate) fn open_regular(path: &Path) -> io::Result<File> {
    require_regular(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        };
        options
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .share_mode(FILE_SHARE_READ);
    }
    let file = options.open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || linked(&meta) {
        return Err(invalid_file());
    }
    Ok(file)
}

fn invalid_file() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "expected a regular profile file in a local directory",
    )
}

fn linked(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    meta.file_type().is_symlink()
}

fn copy(source: &Path, destination: &Path, required: bool) -> io::Result<()> {
    let mut input = match open_regular(source) {
        Ok(file) => file,
        Err(error) if !required && error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let mut output = File::create_new(destination)?;
    io::copy(&mut input, &mut output)?;
    output.sync_all()?;
    drop(output);

    input.rewind()?;
    let mut copied = open_regular(destination)?;
    let mut expected = [0; 32_768];
    let mut actual = [0; 32_768];
    loop {
        let bytes = input.read(&mut expected)?;
        if bytes == 0 {
            if copied.read(&mut actual[..1])? == 0 {
                return Ok(());
            }
            break;
        }
        copied.read_exact(&mut actual[..bytes])?;
        if expected[..bytes] != actual[..bytes] {
            break;
        }
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "profile copy did not preserve the file bytes",
    ))
}
