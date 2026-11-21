use super::*;
use serde_json::json;

#[test]
fn decodes_cast_protobuf_with_bounded_unknown_fields() {
    let message = Message {
        source: "receiver-0".into(),
        destination: "sender-aniverse".into(),
        namespace: "urn:x-cast:com.google.cast.receiver".into(),
        payload: json!({"type":"RECEIVER_STATUS","requestId":2,"status":{"applications":[]}}),
    };
    let frame = frame(&message).unwrap();
    assert_eq!(u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize, frame.len() - 4);
    let mut body = frame[4..].to_vec();
    body.extend_from_slice(&[72, 255,255,255,255,255,255,255,255,255,1, 81, 0,0,0,0,0,0,0,0, 93, 0,0,0,0]);
    let parsed = decode(&body).unwrap().unwrap();
    assert_eq!(parsed.source, message.source);
    assert_eq!(parsed.destination, message.destination);
    assert_eq!(parsed.payload, message.payload);
    body.extend_from_slice(&[98, 127]);
    assert!(decode(&body).is_err());
    assert!(decode(&[8,255,255,255,255,255,255,255,255,255,2]).is_err());
}