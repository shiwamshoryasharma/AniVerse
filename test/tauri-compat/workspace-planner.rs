use super::*;

#[test]
fn planner_round_robins_and_carries_over_extensive_episodes() {
    let current = Entry {
        id: 1,
        media: json!({"id":1,"title":"First"}),
        next: 2,
    };
    let waiting = Entry {
        id: 2,
        media: json!({"id":2,"title":"Second"}),
        next: 1,
    };
    let film = Entry {
        id: 3,
        media: json!({"id":3,"title":"Film"}),
        next: 1,
    };
    let first = candidate(
        current,
        &json!({"status":"FINISHED","episodes":3,"duration":24}),
        1000,
    )
    .unwrap();
    let second = candidate(waiting, &json!({"status":"RELEASING","episodes":10,"duration":15,"nextAiring":{"episode":3,"airingAt":2000}}),1000).unwrap();
    let film = candidate(
        film,
        &json!({"status":"FINISHED","episodes":1,"duration":95}),
        1000,
    )
    .unwrap();
    let plan = build(
        vec![first, second, film],
        40,
        NaiveDate::from_ymd_opt(2026, 11, 21).unwrap(),
    );
    assert_eq!(plan["days"][0]["minutes"], 39);
    assert_eq!(plan["days"][0]["items"][0]["episode"], 2);
    assert_eq!(plan["days"][1]["items"][1]["episode"], 2);
    assert_eq!(plan["unscheduled"], 1);
}
