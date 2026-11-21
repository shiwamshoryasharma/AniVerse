use super::*;
use std::path::PathBuf;

#[test]
fn recognizes_fragment_encryption_boxes() {
    for kind in [b"encv", b"enca", b"pssh", b"tenc", b"senc"] {
        let bytes = [b"\0\0\0\x10moov\0\0\0\x08", kind.as_slice()].concat();
        assert!(has_protection_box(&bytes));
    }
    assert!(!has_protection_box(b"\0\0\0\x10moov\0\0\0\x08avc1"));
    assert!(!has_protection_box(b"plain-text metadata encv"));
}

#[test]
fn rejects_video_only_hls_instead_of_saving_it_without_audio() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let ffmpeg = root.join("build/vendor/ffmpeg/ffmpeg.exe");
    let cache = root.join("test/cache");
    std::fs::create_dir_all(&cache).unwrap();
    let directory = tempfile::tempdir_in(cache).unwrap();
    let fixture = Command::new(&ffmpeg)
        .creation_flags(CREATE_NO_WINDOW)
        .current_dir(directory.path())
        .args([
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=96x54:rate=12",
            "-t",
            "0.5",
            "-c:v",
            "libx264",
            "-f",
            "hls",
            "episode.m3u8",
        ])
        .status()
        .expect("start the pinned FFmpeg fixture generator");
    assert!(
        fixture.success(),
        "Could not prepare the video-only HLS fixture"
    );
    let output = directory.path().join("episode.mp4");
    assert!(tauri::async_runtime::block_on(remux(&ffmpeg, directory.path(), &output)).is_err());
    assert!(
        !output.exists(),
        "An episode missing audio must not produce an MP4"
    );
}
