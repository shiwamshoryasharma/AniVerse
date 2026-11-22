use super::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[test]
fn rejects_revoked_owner_before_any_download_work_is_polled() {
    let started = AtomicBool::new(false);
    let result = tauri::async_runtime::block_on(while_owned(
        async {
            started.store(true, Ordering::SeqCst);
            Ok(7)
        },
        &|| false,
    ));
    assert!(
        result.is_err(),
        "A revoked source owner must not start transfer work"
    );
    assert!(!started.load(Ordering::SeqCst));
    assert!(
        require_owner(&|| false).is_err(),
        "Atomic publication must recheck ownership"
    );
}
#[test]
fn cancelling_a_pending_transfer_drops_all_its_owned_staging_state() {
    struct Cleanup(Arc<AtomicBool>);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    let active = Arc::new(AtomicBool::new(true));
    let dropped = Arc::new(AtomicBool::new(false));
    let check = active.clone();
    let cleanup = Cleanup(dropped.clone());
    let revoke = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(25));
        active.store(false, Ordering::SeqCst);
    });
    let result = tauri::async_runtime::block_on(async {
        timeout(
            Duration::from_secs(1),
            while_owned(
                async move {
                    let _cleanup = cleanup;
                    std::future::pending::<Result<(), RpcError>>().await
                },
                &|| check.load(Ordering::SeqCst),
            ),
        )
        .await
    });
    revoke.join().unwrap();
    assert!(
        result.is_ok(),
        "Revocation must not wait for a blocked segment or FFmpeg timeout"
    );
    assert!(result.unwrap().unwrap_err().message.contains("cancelled"));
    assert!(
        dropped.load(Ordering::SeqCst),
        "Cancellation must drop the operation that owns temporary files and child processes"
    );
}
#[test]
fn a_current_owner_keeps_the_original_transfer_result() {
    assert_eq!(
        tauri::async_runtime::block_on(while_owned(async { Ok(42) }, &|| true)).unwrap(),
        42
    );
}

#[test]
fn scoped_query_roots_cannot_be_created_after_owner_revocation_or_used_by_manual_urls() {
    let root = Url::parse("https://media.example.test/episode.m3u8?ticket=opaque").unwrap();
    let choice = || Selection {
        expected_duration: Some(120.0),
        playlists: vec![root.clone()],
        ..Selection::default()
    };
    assert!(bind_player_scope(&root, choice(), &|| false).is_err());
    let selected = bind_player_scope(&root, choice(), &|| true).unwrap();
    let scope = selected.scope.unwrap();
    assert!(scope.contains(&root));
    assert!(!scope
        .contains(&Url::parse("https://media.example.test/episode.m3u8?ticket=other").unwrap()));
    assert!(!scope.contains(
        &Url::parse("https://media.example.test/unobserved.m3u8?ticket=opaque").unwrap()
    ));
    assert!(!public_media_url(&root));
    assert!(!is_active_media_url(&root));
    assert!(
        tauri::async_runtime::block_on(public_transport(&root)).is_err(),
        "Manual query requests must stop before DNS/network access"
    );
}
#[test]
fn pinned_media_transport_rejects_any_private_dns_answer() {
    let public = "8.8.8.8:443".parse().unwrap();
    assert!(permitted_media_addresses(&[public], false));
    assert!(!permitted_media_addresses(&[], false));
    for private in [
        "127.0.0.1:443",
        "192.168.1.1:443",
        "169.254.169.254:443",
        "[::1]:443",
    ] {
        let private = private.parse().unwrap();
        assert!(!permitted_media_addresses(&[private], false));
        assert!(
            !permitted_media_addresses(&[public, private], false),
            "Mixed DNS answers cannot escape the public-address policy"
        );
    }
    assert!(
        permitted_media_addresses(&["127.0.0.1:443".parse().unwrap()], true),
        "Only an explicit compiled fixture may use loopback"
    );
    assert!(!permitted_media_addresses(
        &["192.168.1.1:443".parse().unwrap()],
        true
    ));
}
