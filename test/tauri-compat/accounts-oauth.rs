#[path = "../../native/aniverse2/oauth_build.rs"]
mod build_config;

use super::*;
use std::{fs, path::PathBuf};

const STATE: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";
const OTHER: &str = "ZBCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";

fn cache() -> PathBuf {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/cache/aniverse2");
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn oauth_validates_routes_state_and_provider_specific_credentials() {
    assert!(valid_state(STATE));
    assert_ne!(random::<32>().ok().unwrap(), random::<32>().ok().unwrap());
    let ani = authorize("anilist", "123", STATE, None, ANILIST_REDIRECT)
        .ok()
        .unwrap();
    assert_eq!(ani.host_str(), Some("anilist.co"));
    assert_eq!(
        ani.query_pairs().find(|(key, _)| key == "state").unwrap().1,
        STATE
    );
    let mal = authorize(
        "mal",
        "private-test-fixture",
        STATE,
        Some("test-verifier"),
        MAL_REDIRECT,
    )
    .ok()
    .unwrap();
    assert_eq!(mal.host_str(), Some("myanimelist.net"));
    assert_eq!(
        mal.query_pairs()
            .find(|(key, _)| key == "redirect_uri")
            .unwrap()
            .1,
        MAL_REDIRECT
    );
    assert_eq!(
        mal.query_pairs()
            .find(|(key, _)| key == "code_challenge")
            .unwrap()
            .1,
        "test-verifier"
    );

    let ani =
        format!("{ANILIST_REDIRECT}#state={STATE}&access_token=fixture-token&expires_in=3600");
    let callback = parse(&ani).unwrap();
    assert_eq!(callback.provider, "anilist");
    assert!(same_secret(&callback.state, STATE));
    assert!(!same_secret(&callback.state, OTHER));
    assert!(matches!(
        callback.grant,
        Grant::AniList {
            expires: Some(3600),
            ..
        }
    ));
    let mal = format!("{MAL_REDIRECT}?state={STATE}&code=fixture-code");
    assert!(matches!(parse(&mal).unwrap().grant, Grant::Mal(_)));
    assert!(matches!(
        parse(&format!("{MAL_REDIRECT}?state={STATE}&error=access_denied"))
            .unwrap()
            .grant,
        Grant::Denied
    ));
    for bad in [
        ani.replace("aniverse2:", "aniverse:"),
        ani.replace("oauth/anilist", "oauth.evil.test/anilist"),
        ani.replace("oauth/anilist", "oauth/myanimelist"),
        ani.replace("#state=", "?state="),
        ani.replace("fixture-token", "fixture%0Atoken"),
        ani.replace("3600", "expired"),
        ani.replace(STATE, "unexpected"),
        format!("{ani}&state={STATE}"),
        format!("{ani}&access_token=second"),
        mal.replace("?state=", "#state="),
    ] {
        assert!(parse(&bad).is_none());
    }
}

#[test]
fn oauth_uses_app_owned_callback_once_and_stores_only_protected_response() {
    let profile = tempfile::tempdir_in(cache()).unwrap();
    let exe = profile.path().join("AniVerse2.exe");
    let other = profile.path().join("Other.exe");
    fs::write(&exe, "test file").unwrap();
    fs::write(&other, "test file").unwrap();
    let command = format!("\"{}\" --oauth-callback \"%1\"", exe.display());
    assert!(spool::owner_command(&command, &exe));
    assert!(!spool::owner_command(&command, &other));
    assert!(!spool::owner_command(&format!("{command} --other"), &exe));

    let mut ticket = spool::Ticket::new(profile.path(), "anilist", STATE).unwrap();
    assert!(ticket.response().unwrap().is_none());
    let wrong_state = format!("{ANILIST_REDIRECT}#state={OTHER}&access_token=unknown-state");
    assert!(spool::deliver(profile.path(), &parse(&wrong_state).unwrap(), &wrong_state).is_err());
    let wrong_provider = format!("{MAL_REDIRECT}?state={STATE}&code=wrong-provider");
    assert!(spool::deliver(
        profile.path(),
        &parse(&wrong_provider).unwrap(),
        &wrong_provider
    )
    .is_err());
    let raw = format!("{ANILIST_REDIRECT}#state={STATE}&access_token=synthetic-fixture-token");
    let callback = parse(&raw).unwrap();
    spool::deliver(profile.path(), &callback, &raw).unwrap();
    assert!(spool::deliver(profile.path(), &callback, &raw).is_err());
    for file in fs::read_dir(profile.path().join("oauth-callbacks")).unwrap() {
        let file = file.unwrap();
        let contents = fs::read_to_string(file.path()).unwrap();
        assert!(!contents.contains("synthetic-fixture-token"));
        assert!(!contents.contains(STATE));
    }
    assert_eq!(ticket.response().unwrap(), Some(raw.clone()));
    assert!(ticket.response().unwrap().is_none());
    drop(ticket);
    assert!(spool::deliver(profile.path(), &callback, &raw).is_err());
}

#[test]
fn oauth_cancel_and_restart_are_idempotent() {
    let broker = Broker::default();
    let first = broker.begin("anilist").ok().unwrap();
    assert!(broker.signing_in("anilist"));
    let second = broker.begin("anilist").ok().unwrap();
    assert!(first.check().is_err());
    drop(first);
    assert!(broker.signing_in("anilist"));
    assert!(second.check().is_ok());
    broker.cancel("anilist").ok().unwrap();
    broker.cancel("anilist").ok().unwrap();
    assert!(second.check().is_err());
    assert!(second
        .complete::<()>(|| panic!("cancelled account must not persist"))
        .is_err());
    assert!(!broker.signing_in("anilist"));
}

#[test]
fn oauth_build_keeps_legacy_clients_separate_from_native_clients() {
    use serde_json::json;
    const LEGACY: &str = "a1b2c3d4e5f67890";
    const NATIVE: &str = "1a2b3c4d5e6f7890";
    let legacy = json!({"anilist": {"clientId": 101}, "myanimelist": {"clientId": LEGACY}});
    let result = build_config::credentials(&legacy, [None; 4]).unwrap();
    assert_eq!(result, ["", "", LEGACY, "101"]);

    let mut config = legacy.clone();
    config["aniverse2"] = json!({
        "anilist": {"clientId": 202},
        "myanimelist": {"clientId": NATIVE},
    });
    let result = build_config::credentials(&config, [None; 4]).unwrap();
    assert_eq!(result, ["202", NATIVE, LEGACY, "101"]);
    let result = build_config::credentials(&config, [Some(" 303 "), Some(""), None, None]).unwrap();
    assert_eq!(result, ["303", "", LEGACY, "101"]);

    config["aniverse2"]["anilist"]["clientSecret"] = json!("fixture-forbidden");
    assert!(build_config::credentials(&config, [None; 4]).is_err());
    assert_eq!(
        build_config::credentials(&legacy, [Some("bad\nvalue"), None, None, None]),
        Err("ANIVERSE2_ANILIST_CLIENT_ID")
    );
}

#[test]
fn oauth_compatibility_uses_exact_legacy_routes_and_provider_origins() {
    let browser = sign_in("mal", Some("native"), Some("legacy"), true).unwrap();
    assert!(!browser.compatibility);
    assert_eq!(browser.redirect, MAL_REDIRECT);
    let fallback = sign_in("mal", Some("native"), Some("legacy"), false).unwrap();
    assert!(fallback.compatibility);
    assert_eq!(fallback.redirect, LEGACY_MAL_REDIRECT);
    assert_eq!(fallback.client, "legacy");
    let authorization = authorize(
        "mal",
        fallback.client,
        STATE,
        Some("fixture-verifier"),
        fallback.redirect,
    )
    .ok()
    .unwrap();
    assert!(authorization
        .query_pairs()
        .any(|(key, value)| key == "redirect_uri" && value == LEGACY_MAL_REDIRECT));

    let legacy = format!("{LEGACY_MAL_REDIRECT}?state={STATE}&code=fixture-code");
    assert!(
        parse(&legacy).is_none(),
        "The installed native protocol must ignore legacy callbacks"
    );
    assert!(matches!(
        parse_expected(&legacy, LEGACY_MAL_REDIRECT, "mal")
            .unwrap()
            .grant,
        Grant::Mal(_)
    ));
    assert!(parse_expected(&legacy, LEGACY_ANILIST_REDIRECT, "anilist").is_none());
    let token = format!("{LEGACY_ANILIST_REDIRECT}#state={STATE}&access_token=fixture-token");
    let callback = parse_expected(&token, LEGACY_ANILIST_REDIRECT, "anilist").unwrap();
    assert!(same_secret(&callback.state, STATE));
    assert!(!same_secret(&callback.state, OTHER));
    assert!(matches!(callback.grant, Grant::AniList { .. }));

    for (raw, provider, assets, expected) in [
        (
            "https://anilist.co/api/v2/oauth/authorize",
            "anilist",
            false,
            true,
        ),
        ("https://cdn.myanimelist.net/image.png", "mal", true, true),
        ("https://cdn.myanimelist.net/image.png", "mal", false, false),
        ("https://myanimelist.net@another.test/", "mal", true, false),
        ("http://anilist.co/", "anilist", true, false),
        ("https://anilist.co:1234/", "anilist", false, false),
        ("https://anilist.co.another.test/", "anilist", true, false),
        ("https://accounts.google.com/", "mal", true, false),
    ] {
        assert_eq!(
            compatibility::allowed(&Url::parse(raw).unwrap(), provider, assets),
            expected,
            "{raw}"
        );
    }
}
