use crate::{stage_database, SnapshotError};
use std::{
    fs::{self, File},
    io,
    path::Path,
    time::Duration,
};

/// Build a disposable, separate candidate profile from the Electron paths.
/// The caller must obtain `config` from the running Electron host. It can be
/// outside `data` for a portable installation or an explicit override.
/// For final cutover the caller must stop app writers before calling this.
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
    copy(
        &config.join("streaming-sites.txt"),
        &target.join("config/streaming-sites.txt"),
        true,
    )?;
    for name in ["filters.txt", "site-recipes.json"] {
        copy(&config.join(name), &target.join("config").join(name), false)?;
    }
    copy(&data.join("profile.id"), &target.join("profile.id"), true)?;
    copy(
        &data.join("graphics.json"),
        &target.join("graphics.json"),
        false,
    )?;
    copy(
        &data.join("adblock-engine.bin"),
        &target.join("adblock-engine.bin"),
        false,
    )?;
    for kind in ["avatar", "banner"] {
        for extension in ["png", "jpg", "jpeg", "webp"] {
            let file = format!("profile/{kind}.{extension}");
            copy(&data.join(&file), &target.join(&file), false)?;
        }
    }
    stage_database(
        &data.join("aniverse.db"),
        &target.join("aniverse.db"),
        expected_schema,
        timeout,
    )?;
    Ok(staged)
}

fn copy(source: &Path, destination: &Path, required: bool) -> io::Result<()> {
    let mut input = match File::open(source) {
        Ok(file) => file,
        Err(error) if !required && error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if !input.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "expected a regular profile file",
        ));
    }
    let mut output = File::create_new(destination)?;
    io::copy(&mut input, &mut output)?;
    output.sync_all()
}
