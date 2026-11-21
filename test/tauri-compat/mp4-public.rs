use super::*;

#[test]
#[ignore = "makes one request to a public CC0 media host"]
fn saves_real_public_mp4_with_identical_bytes() {
    let raw = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";
    let output = std::env::var_os("ANIVERSE2_MP4_VALIDATION_DIR")
        .expect("set a disposable folder under test");
    let output = PathBuf::from(output);
    let expected = std::fs::read(output.join("reference.mp4")).unwrap();
    let actual = output.join("download.mp4");
    assert!(allows_public_mp4(raw, raw));
    let url = Url::parse(raw).unwrap();
    tauri::async_runtime::block_on(async {
        let client = public_transport(&url).await.unwrap();
        transfer::save(&client, &url, &actual, |_, _| {})
            .await
            .unwrap();
    });
    assert_eq!(std::fs::read(&actual).unwrap(), expected);
}
