use super::*;

const SERVICE: &str = "_googlecast._tcp.local";
const SUN: &str = "fixture._googlecast._tcp.local";
const SUN_HOST: &str = "fixture.local";

fn domain(name: &str) -> Vec<u8> {
    let mut result = Vec::new();
    for label in name.split('.') {
        result.push(label.len() as u8);
        result.extend_from_slice(label.as_bytes());
    }
    result.push(0);
    result
}

fn record(owner: &str, record_type: u16, ttl: u32, value: &[u8]) -> Vec<u8> {
    let mut row = domain(owner);
    row.extend_from_slice(&record_type.to_be_bytes());
    row.extend_from_slice(&0x8001u16.to_be_bytes());
    row.extend_from_slice(&ttl.to_be_bytes());
    row.extend_from_slice(&(value.len() as u16).to_be_bytes());
    row.extend_from_slice(value);
    row
}

fn response(id: u16, records: &[Vec<u8>]) -> Vec<u8> {
    let mut packet = vec![0; 12];
    packet[..2].copy_from_slice(&id.to_be_bytes());
    packet[2] = 0x84;
    packet[6..8].copy_from_slice(&(records.len() as u16).to_be_bytes());
    for row in records {
        packet.extend_from_slice(row);
    }
    packet
}

fn service(owner: &str, target: &str, port: u16) -> Vec<u8> {
    let mut value = vec![0; 4];
    value.extend_from_slice(&port.to_be_bytes());
    value.extend(domain(target));
    record(owner, 33, 120, &value)
}

#[test]
fn cast_mdns_assembles_separate_packets_and_returns_existing_device_contract() {
    let mut records = Records::default();
    let pointers = [
        record(SERVICE, 12, 120, &domain(SUN)),
        record(SERVICE, 12, 120, &domain("Other._googlecast._tcp.local")),
    ];
    assert!(records.add(&response(0, &pointers), 0));
    assert!(records.questions().contains(&(records::PTR, SERVICE)));
    assert!(records.questions().contains(&(33, SUN)));
    assert!(records
        .questions()
        .contains(&(16, "other._googlecast._tcp.local")));
    assert!(records.add(&response(0, &[service(SUN, SUN_HOST, 8009)]), 0));
    assert!(records.questions().contains(&(1, SUN_HOST)));
    assert!(records.devices().is_empty());
    let mut text = Vec::new();
    for field in ["id=fixture", "fn=Living room", "md=Google TV"] {
        text.push(field.len() as u8);
        text.extend_from_slice(field.as_bytes());
    }
    assert!(records.add(
        &response(
            0,
            &[
                record(SUN, 16, 120, &text),
                record("Fixture.local", 1, 120, &[192, 168, 1, 20])
            ]
        ),
        0
    ));
    let list = records.devices();
    assert_eq!(
        serde_json::to_value(list).unwrap(),
        serde_json::json!([
            {"id":"fixture","name":"Living room","model":"Google TV","host":"192.168.1.20","port":8009}
        ])
    );
    assert!(records.add(&response(0, &[record(SUN, 33, 0, &[])]), 0));
    assert!(records.devices().is_empty());
}

#[test]
fn cast_mdns_rejects_wrong_id_looping_compression_and_unrelated_or_invalid_records() {
    let mut records = Records::default();
    assert!(!records.add(&response(7, &[service(SUN, SUN_HOST, 8009)]), 6));
    assert!(!records.add(
        &response(0, &[vec![0xc0, 0x0c, 0, 33, 0, 1, 0, 0, 0, 1, 0, 0]]),
        0
    ));
    assert!(records.add(
        &response(
            9,
            &[
                service(SUN, SUN_HOST, 8009),
                service("TV._miracast._tcp.local", "another.local", 8009),
                service("No-port._googlecast._tcp.local", "another.local", 0),
                record(SUN_HOST, 1, 120, &[127, 0, 0, 1]),
                record("another.local", 1, 120, &[192, 168, 1, 22]),
            ]
        ),
        9
    ));
    assert!(records.devices().is_empty());
    assert!(!on_link(
        &[Interface {
            host: "192.168.1.1".parse().unwrap(),
            mask: 0xffffff00
        }],
        "192.168.2.20".parse().unwrap()
    ));
}

#[test]
fn cast_mdns_reads_a_valid_compressed_record_owner() {
    let mut packet = records::query(0, &[(1, SUN_HOST)]);
    packet[2] = 0x84;
    packet[6..8].copy_from_slice(&1u16.to_be_bytes());
    packet.extend_from_slice(&[
        0xc0, 0x0c, 0, 1, 0x80, 1, 0, 0, 0, 120, 0, 4, 192, 168, 1, 20,
    ]);
    let mut records = Records::default();
    assert!(records.add(&packet, 0));
    assert!(records.add(&response(0, &[service(SUN, SUN_HOST, 8009)]), 0));
    assert_eq!(records.devices()[0].host, Ipv4Addr::new(192, 168, 1, 20));
}
