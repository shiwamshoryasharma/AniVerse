use super::*;

fn norm(parts: &[(f64, Vec<u8>)]) -> Result<Normalized, RpcError> { super::normalize(parts, 0.0) }
fn track_at(parts: &[(f64, &str)], media_start: f64) -> Normalized {
    super::normalize(&parts.iter().map(|(start, text)| (*start, text.as_bytes().to_vec())).collect::<Vec<_>>(),media_start).unwrap()
}
fn track(parts: &[(f64, &str)]) -> Normalized {track_at(parts,0.0)}
#[test]
fn reads_direct_unicode_captions_without_changing_their_relative_clock() {
    let result=track_at(&[(0.0,"\u{feff}WEBVTT\r\n\r\ncue-a\r\n00:01.250 --> 00:03.500 align:start\r\nHello 世界\r\nSecond line\r\n")],1.4);
    assert_eq!(result.timeline,Timeline::Relative);
    assert!(result.text.contains("00:00:01.250 --> 00:00:03.500 align:start\nHello 世界\nSecond line"));
}
#[test]
fn maps_nonzero_local_and_mpegts_to_the_probed_media_start() {
    let result=track_at(&[(0.0,"WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:05.000,MPEGTS:900000\n\n00:06.250 --> 00:07.000\nMapped\n")],10.0);
    assert_eq!(result.timeline,Timeline::AbsoluteMapped);
    assert!(result.text.contains("00:00:01.250 --> 00:00:02.000\nMapped"));
}
#[test]
fn deduplicates_boundary_cues_without_adding_segment_start_to_global_cue_times() {
    let result=track(&[
        (0.0,"WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0\n\n00:01.500 --> 00:02.500\nBoundary\n"),
        (2.0,"WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0\n\ncue-copy\n00:01.500 --> 00:02.500\nBoundary\n\n00:03.000 --> 00:04.000\nLater\n"),
    ]);
    assert_eq!(result.text.matches("Boundary").count(),1);
    assert_eq!(result.cue_count,2);
    assert!(result.text.contains("00:00:03.000 --> 00:00:04.000\nLater"));
}
#[test]
fn maps_segment_local_cues_on_an_advancing_mpeg_clock() {
    let result=track(&[
        (0.0,"WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n00:00.500 --> 00:01.000\nFirst\n"),
        (2.0,"WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:180000\n\n00:00.500 --> 00:01.000\nSecond\n"),
    ]);
    assert!(result.text.contains("00:00:00.500 --> 00:00:01.000\nFirst"));
    assert!(result.text.contains("00:00:02.500 --> 00:00:03.000\nSecond"));
}
#[test]
fn unwraps_33_bit_mpegts_near_the_media_clock_in_both_epochs() {
    let parts=[
        (0.0,"WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:8589844592\n\n00:00.250 --> 00:00.500\nBefore wrap\n"),
        (2.0,"WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:90000\n\n00:00.250 --> 00:00.500\nAfter wrap\n"),
    ];
    let result=track_at(&parts,8_589_844_592.0/90_000.0);
    assert!(result.text.contains("00:00:00.250 --> 00:00:00.500\nBefore wrap"));
    assert!(result.text.contains("00:00:02.250 --> 00:00:02.500\nAfter wrap"));
    let after=track_at(&[parts[1]],1.0);
    assert!(after.text.contains("00:00:00.250 --> 00:00:00.500\nAfter wrap"));
}
#[test]
fn clamps_a_cue_crossing_zero_and_discards_only_cues_before_the_media() {
    let result=track_at(&[(0.0,"WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0\n\n00:00.100 --> 00:00.300\nBefore\n\n00:00.500 --> 00:01.500\nCrossing\n")],1.0);
    assert_eq!(result.cue_count,1);
    assert!(!result.text.contains("Before"));
    assert!(result.text.contains("00:00:00.000 --> 00:00:00.500\nCrossing"));
}
#[test]
fn keeps_distinct_overlapping_cues_and_skips_noncue_metadata() {
    let result=track(&[(0.0,"WEBVTT\n\nNOTE note text\nnot a cue\n\nSTYLE\n::cue { color: red }\n\nREGION\nid:bottom\n\n00:00.000 --> 00:02.000\nOne\n\n00:01.000 --> 00:03.000\nTwo\n")]);
    assert!(result.text.contains("\nOne\n"));assert!(result.text.contains("\nTwo\n"));
    assert!(!result.text.contains("color: red"));assert!(!result.text.contains("note text"));
}
#[test]
fn accepts_empty_vtt_segments_but_refuses_arbitrary_documents_and_bad_timestamps() {
    assert_eq!(track(&[(0.0,"WEBVTT\n\n")]).text,"WEBVTT\n\n");
    for text in [
        "<html>not captions</html>","WEBVTTbad\n\n","WEBVTT\n\n00:60.000 --> 00:61.000\nBad\n",
        "WEBVTT\n\n00:01.000 --> 00:00.500\nReverse\n","WEBVTT\n\n00:00.000 --> 00:01.000\nNull\0text\n",
        "WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:8589934592\n\n",
        "WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,LOCAL:00:00:01.000,MPEGTS:0\n\n",
        "WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000\n\n",
    ] { assert!(norm(&[(0.0,text.as_bytes().to_vec())]).is_err(),"{text}"); }
    assert!(norm(&[(0.0,vec![0xff,0xfe])]).is_err());
}
#[test]
fn bounds_input_cue_count_and_playlist_coordinates() {
    assert!(norm(&[(0.0,vec![b'x';2*1024*1024+1])]).is_err());
    let huge=format!("WEBVTT\n\n{}", "00:00.000 --> 00:01.000\nCue\n\n".repeat(16_385));
    assert!(norm(&[(0.0,huge.into_bytes())]).is_err());
    for start in [f64::NAN,f64::INFINITY,-1.0,21601.0] {assert!(norm(&[(start,b"WEBVTT\n\n".to_vec())]).is_err());}
    assert!(norm(&[(2.0,b"WEBVTT\n\n".to_vec()),(1.0,b"WEBVTT\n\n".to_vec())]).is_err());
    for start in [f64::NAN,f64::INFINITY] {assert!(super::normalize(&[(0.0,b"WEBVTT\n\n".to_vec())],start).is_err());}
}
