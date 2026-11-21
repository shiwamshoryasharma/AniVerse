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
    let ani = authorize("anilist", "123", STATE, None).ok().unwrap();
    assert_eq!(ani.host_str(), Some("anilist.co"));
    assert_eq!(
        ani.query_pairs().find(|(key, _)| key == "state").unwrap().1,
        STATE
    );
    let mal = authorize("mal", "private-test-fixture", STATE, Some("test-verifier"))
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
