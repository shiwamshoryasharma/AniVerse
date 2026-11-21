use super::*;
use std::{fs, path::Path, thread};

#[test]
fn chrome_cast_rejects_unavailable_sender_processing_and_bad_media() {
    let mut request: Start = serde_json::from_value(json!({"deviceId":"chrome:fixture","media":{
        "kind":"mp4","url":"https://example.com/episode.mp4","title":"Fixture"}}))
    .unwrap();
    assert!(request.validate(false).is_ok());
    request.media.upscale4k = true;
    assert!(request.validate(false).is_err());
    request.media.upscale4k = false;
    request.media.url = "file:///C:/movie.mp4".to_owned();
    assert!(request.validate(false).is_err());
}

#[test]
#[ignore = "opens installed Chrome in an isolated test profile and runs Cast.enable"]
fn chrome_cast_uses_real_private_pipe() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/cache/aniverse2");
    fs::create_dir_all(&root).unwrap();
    let profile = tempfile::tempdir_in(root).unwrap();
    let cancel = AtomicBool::new(false);
    let mut chrome = Chrome::open(profile.path(), &cancel).unwrap();
    let end = Instant::now() + Duration::from_secs(5);
    let status = loop {
        match chrome.command("GET_STATUS", None, &cancel) {
            Ok(status) => break status,
            Err(error) if Instant::now() >= end => panic!("{error}"),
            Err(_) => thread::sleep(Duration::from_millis(50)),
        }
    };
    assert_eq!(status["playerState"], "PAUSED");
    assert!(chrome.current().is_none());
    assert_eq!(
        chrome.command("VOLUME", Some(0.25), &cancel).unwrap()["volume"]["level"],
        0.25
    );
    drop(chrome);
    let end = Instant::now() + Duration::from_secs(3);
    while fs::read_dir(profile.path()).unwrap().next().is_some() && Instant::now() < end {
        thread::sleep(Duration::from_millis(100));
    }
    assert!(
        fs::read_dir(profile.path()).unwrap().next().is_none(),
        "Cast profile still exists"
    );
}

#[test]
fn mirror_ingress_commits_only_issued_latest_frames() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let ingress = Ingress::new();
    let jpeg = STANDARD.encode([0xff, 0xd8, 0xff, 7, 0xff, 0xd9]);
    assert_eq!(ingress.offer("forged"), None);
    let first = ingress.offer(&jpeg).unwrap();
    let second = ingress.offer(&jpeg).unwrap();
    assert!(!ingress.acknowledge(second + 1));
    assert!(ingress.acknowledge(first));
    assert!(ingress.latest(0).is_none());
    assert!(ingress.acknowledge(second));
    assert_eq!(ingress.latest(0).unwrap().sequence, second);
    assert!(!ingress.acknowledge(second));
    assert!(ingress.latest(second).is_none());
    ingress.close();
    assert!(ingress.is_closed());
    assert_eq!(ingress.offer(&jpeg), None);
    assert!(ingress.latest(0).is_none());
}

#[test]
fn mirror_companion_serves_only_acknowledged_scoped_frames_and_revokes() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    tauri::async_runtime::block_on(async {
        let host = companion::Host::open().unwrap();
        let ingress = Arc::new(Ingress::new());
        let url = host.mirror(ingress.clone());
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        let fixture = [0xff, 0xd8, 0xff, 7, 0xff, 0xd9];
        let sequence = ingress.offer(&STANDARD.encode(fixture)).unwrap();
        let request = format!("{url}?after=0");
        assert_eq!(client.get(&request).send().await.unwrap().status(), 204);
        assert!(ingress.acknowledge(sequence));
        let response = client.get(&request).send().await.unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["content-type"], "image/jpeg");
        assert_eq!(response.headers()["x-frame-sequence"], sequence.to_string());
        assert_eq!(response.bytes().await.unwrap().as_ref(), &fixture);
        assert_eq!(
            client
                .get(format!("{}discarded?after=0", host.url))
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        assert_eq!(
            client
                .get(&request)
                .header("origin", "https://wrong.example")
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        ingress.close();
        ingress.closed().await;
        assert_eq!(client.get(&request).send().await.unwrap().status(), 410);
    });
}

#[test]
#[ignore = "opens installed Chrome and renders one JPEG from the neutral player fixture"]
fn chrome_mirror_decodes_only_committed_loopback_frames_and_stops() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/cache/aniverse2");
    let jpeg = fs::read(root.join("player-media-fixtures/companion-mirror.jpg")).unwrap();
    let profile = tempfile::tempdir_in(root).unwrap();
    let cancel = AtomicBool::new(false);
    let ingress = Arc::new(Ingress::new());
    let sequence = ingress.offer(&STANDARD.encode(&jpeg)).unwrap();
    assert!(ingress.acknowledge(sequence));
    let mut chrome = Chrome::open(profile.path(), &cancel).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match chrome.command("GET_STATUS", None, &cancel) {
            Ok(_) => break,
            Err(error) if Instant::now() >= deadline => panic!("{error}"),
            Err(_) => thread::sleep(Duration::from_millis(50)),
        }
    }
    let output = chrome
        .mirror_preview("Neutral website capture", &ingress)
        .unwrap();
    assert_eq!(output["playerState"], "PLAYING");
    assert_eq!(output["volume"]["muted"], true);
    assert_eq!(output["media"]["duration"], 0);
    ingress.close();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let output = chrome.command("GET_STATUS", None, &cancel).unwrap();
        if output["playerState"] == "IDLE" {
            assert_eq!(output["idleReason"], "FINISHED");
            break;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(90));
    }
}
