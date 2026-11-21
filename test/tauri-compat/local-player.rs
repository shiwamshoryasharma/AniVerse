use super::*;
use std::fs;

fn fixture_dir() -> tempfile::TempDir {
    let root = std::env::var_os("ANIVERSE2_MP4_VALIDATION_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/cache/aniverse2")
        });
    fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root).unwrap()
}

fn request(id: Uuid, range: Option<&str>) -> Request<Vec<u8>> {
    let mut builder = Request::builder().uri(format!("{ORIGIN}/{id}"));
    if let Some(range) = range {
        builder = builder.header(header::RANGE, range);
    }
    builder.body(vec![]).unwrap()
}

#[test]
fn local_video_uses_exact_selected_file_handle_and_revokes_its_grant() {
    let folder = fixture_dir();
    let path = folder.path().join("chosen.mp4");
    let expected = b"fixture media bytes";
    fs::write(&path, expected).unwrap();
    let (grant, name) = open_video(path.clone()).unwrap();
    let id = grant.token;
    let service = Service::default();
    *service.media.lock().unwrap() = Some(Arc::new(grant));
    assert_eq!(name, "chosen.mp4");
    fs::rename(&path, folder.path().join("old.mp4")).unwrap();
    fs::write(&path, b"wrong replacement").unwrap();
    let range = request(id, Some("bytes=8-12"));
    let result = service.grant_for(&range).unwrap().read(&range);
    assert_eq!(result.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(result.headers()[header::CONTENT_RANGE], "bytes 8-12/19");
    assert_eq!(result.body(), &expected[8..=12]);
    assert!(service.grant_for(&request(Uuid::new_v4(), None)).is_none());
    let cross_origin = Request::builder()
        .uri(format!("{ORIGIN}/{id}"))
        .header(header::ORIGIN, "https://example.test")
        .body(vec![])
        .unwrap();
    assert!(service.grant_for(&cross_origin).is_none());
    service
        .release(Some(&json!({"url": format!("{ORIGIN}/{id}")})))
        .unwrap();
    assert!(service.grant_for(&range).is_none());
}

#[test]
fn ranges_are_bounded_and_filenames_and_subtitles_are_validated() {
    let folder = fixture_dir();
    let path = folder.path().join("large.mp4");
    File::create(&path).unwrap().set_len(MAX_READ + 11).unwrap();
    let (grant, _) = open_video(path).unwrap();
    let page = grant.read(&request(grant.token, Some("bytes=0-")));
    assert_eq!(page.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(page.body().len(), MAX_READ as usize);
    let suffix = grant.read(&request(grant.token, Some("bytes=-11")));
    assert_eq!(suffix.body().len(), 11);
    assert_eq!(
        grant
            .read(&request(grant.token, Some("bytes=0-10,20-30")))
            .status(),
        StatusCode::RANGE_NOT_SATISFIABLE
    );
    let file = folder.path().join("captions.srt");
    fs::write(
        &file,
        "\u{feff}1\r\n00:00:01,000 --> 00:00:04,500\r\nFixture caption\r\n",
    )
    .unwrap();
    let subtitle = read_subtitle(file).unwrap();
    assert_eq!(
        subtitle["text"],
        "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.500\nFixture caption\n"
    );
    assert!(subtitle_vtt("\0").is_err());
    assert!(open_video(folder.path().to_owned()).is_err());
    assert!(read_subtitle(folder.path().join("wrong.mp4")).is_err());
}

#[cfg(windows)]
#[test]
fn collection_grant_verifies_the_open_file_inside_its_selected_root() {
    let fixture = fixture_dir();
    let root = fixture.path().join("library");
    fs::create_dir(&root).unwrap();
    let outside = fixture.path().join("outside.mp4");
    let inside = root.join("inside.mp4");
    fs::write(&outside, b"unselected").unwrap();
    fs::write(&inside, b"selected").unwrap();
    let allowed = [root.canonicalize().unwrap()];
    assert!(open_video_checked(outside, Some(&allowed)).is_err());
    let (grant, name) = open_video_checked(inside, Some(&allowed)).unwrap();
    assert_eq!(name, "inside.mp4");
    assert_eq!(grant.read(&request(grant.token, None)).body(), b"selected");
}

#[test]
fn stale_local_open_cannot_replace_the_latest_grant() {
    let fixture = fixture_dir();
    let older = fixture.path().join("older.mp4");
    let newer = fixture.path().join("newer.mp4");
    fs::write(&older, b"older").unwrap();
    fs::write(&newer, b"newer").unwrap();
    let service = Service::default();
    let first = service.reserve_grant();
    let second = service.reserve_grant();
    let (current, name) = open_video(newer).unwrap();
    let token = current.token;
    service.install_grant(second, current, name).unwrap();
    let (obsolete, name) = open_video(older).unwrap();
    assert!(service.install_grant(first, obsolete, name).is_err());
    assert!(service.grant_for(&request(token, None)).is_some());
}
