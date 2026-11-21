use super::*;

#[test]
fn oauth_callback_requires_exact_loopback_host_path_and_single_transaction_state() {
    let authority = "127.0.0.1:29389";
    let request =
        |target: &str, host: &str| format!("GET {target} HTTP/1.1\r\nHost: {host}\r\n\r\n");
    let accept = |target: &str| parse_callback(&request(target, authority), authority, "expected");
    assert_eq!(
        accept("/oauth2callback?state=expected&code=fixture-code"),
        Some(Some("fixture-code".to_owned()))
    );
    assert_eq!(
        accept("/oauth2callback?state=expected&error=access_denied"),
        Some(None)
    );
    assert!(accept("/oauth2callback?state=forged&code=fixture-code").is_none());
    assert!(accept("/oauth2callback?state=expected&state=forged&code=fixture-code").is_none());
    assert!(accept("/oauth2callback?state=expected&code=first&code=second").is_none());
    assert!(accept("/other?state=expected&code=fixture-code").is_none());
    assert!(parse_callback(
        &request(
            "/oauth2callback?state=expected&code=fixture-code",
            "example.com"
        ),
        authority,
        "expected"
    )
    .is_none());
}
