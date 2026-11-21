use super::*;

#[test]
fn private_source_leases_are_title_bound_revocable_and_bounded() {
    let registry = Registry::default();
    let lease = registry.issue(183).unwrap();
    let partition = format!("private-{}-fixture-origin", lease.token);
    assert_eq!(registry.resolve(&partition, "fixture-origin"), Some(lease));
    assert_eq!(registry.resolve(&partition, "other-origin"), None);
    assert!(!registry.contains(Lease {
        token: lease.token,
        media_id: 184
    }));
    assert!(registry.issue(0).is_none());
    for media in 1..=63 {
        assert!(registry.issue(media).is_some());
    }
    assert!(registry.issue(300).is_none());
    registry.revoke(lease.token);
    assert_eq!(registry.resolve(&partition, "fixture-origin"), None);
    let replacement = registry.issue(184).unwrap();
    registry.clear();
    assert!(!registry.contains(replacement));
}
