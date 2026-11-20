use std::{ffi::OsStr, io, os::windows::ffi::OsStrExt, path::Path};
use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

/// Publish a fully staged copy into a new sibling directory without replacing
/// existing data. Installer ownership and legacy removal are separate steps.
pub fn publish_profile_copy(stage: tempfile::TempDir, destination: &Path) -> io::Result<()> {
    let source = stage.path().canonicalize()?;
    let parent = destination
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing profile parent"))?
        .canonicalize()?;
    if source.parent() != Some(parent.as_path()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "staging and copy must be siblings",
        ));
    }
    let filename = destination
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing profile name"))?;
    let target = parent.join(filename);
    let source = wide(source.as_os_str());
    let target = wide(target.as_os_str());
    // Both paths are NUL-terminated and stable for the duration of MoveFileExW.
    // Omitting REPLACE_EXISTING and COPY_ALLOWED makes races fail without
    // writing an existing profile or copying to another volume.
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let _ = stage.keep();
    Ok(())
}

fn wide(path: &OsStr) -> Vec<u16> {
    path.encode_wide().chain(std::iter::once(0)).collect()
}
