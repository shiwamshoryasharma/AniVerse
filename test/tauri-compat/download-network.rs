use super::*;

#[test]
fn observed_context_is_bounded_sensitive_and_excludes_transport_headers() {
    let mut calls = Vec::new();
    let headers = captured_headers(|name| {
        calls.push(name.clone());
        match name.as_str() {
            "cookie" => Some("fixture_session=owned".into()),
            "authorization" => Some("Bearer fixture-only".into()),
            "referer" => Some("https://player.example.test/watch?opaque=1".into()),
            "origin" => Some("https://player.example.test\r\nInvalid: merged".into()),
            "user-agent" => Some("x".repeat(MAX_HEADER + 1)),
            _ => None,
        }
    });
    assert!(headers[COOKIE].is_sensitive());
    assert!(headers[AUTHORIZATION].is_sensitive());
    assert!(headers[REFERER].is_sensitive());
    assert!(!headers.contains_key(ORIGIN));
    assert!(!headers.contains_key(USER_AGENT));
    for forbidden in ["host", "range", "accept-encoding", "connection"] {
        assert!(!calls.iter().any(|name| name.as_str() == forbidden));
    }
    assert!(!format!("{headers:?}").contains("fixture_session=owned"));
}

#[test]
fn ledger_is_generation_bound_and_replaces_the_exact_url_only() {
    let old = "https://media.example.test/file?sig=old";
    let current = "https://media.example.test/file?sig=current";
    let mut ledger = Ledger::default();
    let mut entry = Response::test_entry(old, "video/mp4", HeaderMap::new());
    entry.seen = Instant::now() - MAX_AGE - Duration::from_secs(1);
    ledger.record(entry);
    ledger.record(Response::test_entry(current, "video/mp4", HeaderMap::new()));
    ledger.record(Response::test_entry(
        current,
        "video/webm",
        HeaderMap::new(),
    ));
    let active = ledger.snapshot(1, 1);
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].url.as_str(), current);
    assert_eq!(active[0].mime, "video/webm");
    assert!(ledger.snapshot(2, 1).is_empty());
    assert!(ledger.snapshot(1, 2).is_empty());
    ledger.clear();
    assert!(ledger.snapshot(1, 1).is_empty());
}
