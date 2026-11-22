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
    assert!(tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(convert_local(
            &ffmpeg,
            directory.path(),
            "episode.m3u8",
            "hls",
            &output
        ))
        .is_err());
    assert!(
        !output.exists(),
        "An episode missing audio must not produce an MP4"
    );
}

#[test]
fn checks_container_bytes_instead_of_remote_file_extensions() {
    let mut ts = vec![0u8; 188 * 4];
    for packet in ts.chunks_exact_mut(188) {
        packet[0] = 0x47;
    }
    assert_eq!(
        segment_format(&ts, ts.len() as u64, false, false),
        Some("ts")
    );
    let fragment = b"\0\0\0\x08moof\0\0\0\x0cmdatdata";
    assert_eq!(
        segment_format(fragment, fragment.len() as u64, true, false),
        Some("m4s")
    );
    for bytes in [
        b"\x89PNG\r\n\x1a\nactual image".as_slice(),
        b"RIFFxxxxWEBPactual image",
        b"<html>login required</html>",
        b"not media",
    ] {
        assert_eq!(
            segment_format(bytes, bytes.len() as u64, false, false),
            None
        );
        assert_eq!(segment_format(bytes, bytes.len() as u64, true, false), None);
    }
}

#[test]
fn binds_video_playlist_duration_to_the_playing_episode() {
    let playlist = |seconds| Playlist::Media {
        init: None,
        segments: vec![(
            seconds,
            Url::parse("https://media.example.test/part.png?opaque=1").unwrap(),
        )],
    };
    assert!(matches_duration(&playlist(120.0), Some(120.0)));
    assert!(matches_duration(&playlist(122.9), Some(120.0)));
    assert!(
        !matches_duration(&playlist(12.0), Some(120.0)),
        "a recently observed short ad must not replace the playing episode"
    );
    assert!(!matches_duration(&playlist(125.0), Some(120.0)));
    assert!(matches_duration(&playlist(602.0), Some(600.0)));
    assert!(
        matches_duration(&playlist(12.0), None),
        "legacy explicit selections retain their previous contract"
    );
}

#[test]
fn owned_scope_authorizes_only_captured_roots_and_validated_manifest_children() {
    let root = Url::parse("https://media.example.test/episode.m3u8?opaque=one").unwrap();
    let child = Url::parse("https://media.example.test/part.png?opaque=two").unwrap();
    let unrelated = Url::parse("https://media.example.test/unrelated.m3u8?opaque=three").unwrap();
    assert!(
        !super::super::public_media_url(&root),
        "generic URL policy stays queryless"
    );
    let mut scope = OwnedScope::from_owned_selection(&[root.clone()], None).unwrap();
    assert!(scope.contains(&root));
    assert!(!scope.contains(&child));
    assert!(!scope.contains(&unrelated));
    let text = "#EXTM3U\n#EXTINF:1,\npart.png?opaque=two\n#EXT-X-ENDLIST\n";
    assert!(hls::parse(&root, text).is_err());
    let playlist = hls::parse_owned(&root, text).unwrap();
    scope.authorize_playlist(&playlist);
    assert!(scope.contains(&child));
    assert!(!scope.contains(&unrelated));
    assert!(hls::parse_owned(
        &root,
        "#EXTM3U\n#EXTINF:1,\nhttps://other.example.test/part.png?opaque=two\n#EXT-X-ENDLIST\n"
    )
    .is_err());
}

#[test]
fn revoked_owner_cannot_publish_a_finished_mp4_or_replace_an_existing_file() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/cache");
    std::fs::create_dir_all(&root).unwrap();
    let directory = tempfile::tempdir_in(root).unwrap();
    let stage = || {
        let file = tempfile::NamedTempFile::new_in(directory.path()).unwrap();
        let mut bytes = vec![0u8; 4096];
        bytes[..24].copy_from_slice(b"\x00\x00\x00\x18ftypisom\x00\x00\x00\x00isommp42");
        std::fs::write(file.path(), bytes).unwrap();
        file.into_temp_path()
    };
    let destination = directory.path().join("episode.mp4");
    let checks = AtomicUsize::new(0);
    let result = tauri::async_runtime::block_on(publish_mp4(stage(), &destination, &|| {
        checks.fetch_add(1, Ordering::SeqCst) == 0
    }));
    assert!(result.unwrap_err().message.contains("cancelled"));
    assert!(
        !destination.exists(),
        "A revoked lease must not atomically publish completed bytes"
    );
    assert_eq!(
        std::fs::read_dir(directory.path()).unwrap().count(),
        0,
        "Revocation must clean completed staging data"
    );
    std::fs::write(&destination, b"existing destination").unwrap();
    assert!(tauri::async_runtime::block_on(publish_mp4(stage(), &destination, &|| true)).is_err());
    assert_eq!(
        std::fs::read(&destination).unwrap(),
        b"existing destination"
    );
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[test]
fn protected_or_unmatched_direct_primary_cannot_select_a_stale_clear_playlist() {
    let primary = Url::parse("https://media.example.test/current.m3u8").unwrap();
    let stale = Url::parse("https://media.example.test/previous.m3u8").unwrap();
    let segment = Url::parse("https://media.example.test/previous.png").unwrap();
    let previous = Loaded {
        url: stale,
        client: Client::new(),
        playlist: Playlist::Media {
            init: None,
            segments: vec![(6.0, segment.clone())],
        },
    };
    let selection = Selection {
        direct_primary: true,
        expected_duration: Some(6.0),
        observations: vec![segment],
        ..Selection::default()
    };
    assert!(hls::parse(&primary, "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n#EXTINF:6,\ncurrent.webp\n#EXT-X-ENDLIST\n").is_err());
    assert_eq!(
        select_video(&primary, &selection, &[previous.clone()], &[], &[]),
        None,
        "A failed protected primary must not be replaced by a same-duration stale clear root"
    );
    let current = Loaded {
        url: primary.clone(),
        client: Client::new(),
        playlist: Playlist::Media {
            init: None,
            segments: vec![(6.0, primary.join("current.webp").unwrap())],
        },
    };
    assert_eq!(
        select_video(&primary, &selection, &[current, previous], &[], &[]),
        None,
        "Observations from a different direct root must not win over the selected primary"
    );
}
