use super::*;

const BASE: &str = "https://media.example.test/video/episode.m3u8";

fn parsed(text: &str) -> Result<Playlist, RpcError> {
    parse(&Url::parse(BASE).unwrap(), text)
}

fn rejected(text: &str) -> RpcError {
    match parsed(text) {
        Ok(_) => panic!("Unexpectedly accepted unsupported HLS playlist"),
        Err(error) => error,
    }
}

#[test]
fn reads_clear_muxed_segments_in_order() {
    let Playlist::Media { init, segments } = parsed(
        "#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:1.25,\nfirst.ts\n#EXTINF:2,\n./second.ts\n#EXT-X-ENDLIST\n",
    ).unwrap() else { panic!("Expected a complete media playlist") };
    assert!(init.is_none());
    assert_eq!(
        segments[0],
        (
            1.25,
            Url::parse("https://media.example.test/video/first.ts").unwrap()
        )
    );
    assert_eq!(segments[1].0, 2.0);
    assert_eq!(segments[1].1.path(), "/video/second.ts");
}

#[test]
fn reads_one_muxed_variant_and_one_shared_fragment_init() {
    let Playlist::Variant(variant) =
        parsed("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2500000\nhigh/index.m3u8\n").unwrap()
    else {
        panic!("Expected a single variant")
    };
    assert_eq!(variant.path(), "/video/high/index.m3u8");
    let Playlist::Media { init, segments } = parse(
        &variant,
        "#EXTM3U\n#EXT-X-MAP:URI=\"start.mp4\"\n#EXTINF:2,\n00.m4s\n#EXT-X-ENDLIST\n",
    )
    .unwrap() else {
        panic!("Expected a media playlist")
    };
    assert_eq!(init.unwrap().path(), "/video/high/start.mp4");
    assert_eq!(segments[0].1.path(), "/video/high/00.m4s");
}

#[test]
fn refuses_keys_before_any_segment_transport_and_requires_complete_playlists() {
    for tag in [
        "#EXT-X-KEY:METHOD=AES-128,URI=\"key\"",
        "#EXT-X-KEY:METHOD=SAMPLE-AES",
        "#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI=\"key\"",
    ] {
        let input = format!("#EXTM3U\n{tag}\n#EXTINF:2,\nclip.ts\n#EXT-X-ENDLIST\n");
        assert!(rejected(&input).message.contains("protected"));
    }
    assert!(rejected("#EXTM3U\n#EXTINF:2,\nclip.ts\n")
        .message
        .contains("on-demand"));
}

#[test]
fn refuses_other_origins_and_credentialized_or_ambiguous_media_references() {
    for uri in [
        "https://other.example.test/file.ts",
        "http://media.example.test/file.ts",
        "//127.0.0.1/admin",
        "file:///C:/Windows/win.ini",
        "file.ts#private",
        "https://u:p@media.example.test/video/file.ts",
    ] {
        let input = format!("#EXTM3U\n#EXTINF:2,\n{uri}\n#EXT-X-ENDLIST\n");
        assert!(rejected(&input).message.contains("outside"));
    }
    assert!(parsed("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=200\nhigh.m3u8\n").is_ok());
    assert!(parsed("#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"Default\",URI=\"audio.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=200,AUDIO=\"a\"\nhigh.m3u8\n").is_ok());
    rejected("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"512@0\"\n#EXTINF:2,\npart.m4s\n#EXT-X-ENDLIST\n");
}

#[test]
fn generic_active_media_url_remains_public_https_and_queryless() {
    for value in [BASE, "https://media.example.test/episode.MP4"] {
        assert!(super::super::is_active_media_url(
            &Url::parse(value).unwrap()
        ));
    }
    for value in [
        "https://localhost/file.m3u8",
        "https://192.168.0.1/file.mp4",
        "https://media.example.test:445/file.m3u8",
        "https://media.example.test/files/a.m3u8?opaque=example",
        "https://media.example.test/a.mpd",
        "https://media.example.test/a.m3u8#x",
    ] {
        assert!(
            !super::super::is_active_media_url(&Url::parse(value).unwrap()),
            "{value}"
        );
    }
}

#[test]
fn accepts_selected_master_audio_and_subtitle_renditions_with_opaque_queries() {
    assert!(parse_owned(&Url::parse(BASE).unwrap(), "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"Original\",DEFAULT=YES,URI=\"audio.m3u8?opaque=1\"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"English\",LANGUAGE=\"en\",URI=\"subs.m3u8?opaque=2\"\n#EXT-X-STREAM-INF:BANDWIDTH=100,AUDIO=\"audio\",SUBTITLES=\"subs\"\nlow.m3u8?opaque=3\n#EXT-X-STREAM-INF:BANDWIDTH=200,AUDIO=\"audio\",SUBTITLES=\"subs\"\nhigh.m3u8?opaque=4\n").is_ok());
}

#[test]
fn accepts_manifest_listed_image_suffixes_without_treating_them_as_images() {
    assert!(parse_owned(&Url::parse(BASE).unwrap(), "#EXTM3U\n#EXTINF:1,\nfirst.png?opaque=one\n#EXTINF:1,\nsecond.webp?opaque=two\n#EXT-X-ENDLIST\n").is_ok());
}

#[test]
fn media_variant_urls_need_no_file_extension_and_preserve_quality() {
    let playlist = parsed("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1700000,RESOLUTION=1280x720\nplay/720\n#EXT-X-STREAM-INF:BANDWIDTH=2900000,RESOLUTION=1920x1080\nplay/1080\n").unwrap();
    let Playlist::Master { variants, .. } = playlist else {
        panic!("expected a master playlist");
    };
    assert!(variants[0].url.path().ends_with("/play/720"));
    assert_eq!(variants[0].height, Some(720));
    assert_eq!(variants[1].height, Some(1080));
    assert_eq!(variants[1].bandwidth, Some(2_900_000));
}
