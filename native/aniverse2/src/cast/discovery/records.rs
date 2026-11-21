use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    net::Ipv4Addr,
};

const SERVICE: &str = "_googlecast._tcp.local";
pub(super) const PTR: u16 = 12;
const SRV: u16 = 33;
const TXT: u16 = 16;
const A: u16 = 1;

#[derive(Debug, PartialEq, Eq, Serialize)]
pub(super) struct Device {
    pub(super) host: Ipv4Addr,
    pub(super) id: String,
    name: String,
    model: String,
    port: u16,
}

struct Record {
    kind: u16,
    name: String,
    ttl: u32,
    data: Data,
}

enum Data {
    Address(Ipv4Addr),
    Pointer(String),
    Service { port: u16, target: String },
    Text(BTreeMap<String, String>),
    Goodbye,
}

#[derive(Default)]
pub(super) struct Records(BTreeMap<(u16, String), Data>);

impl Records {
    pub(super) fn add(&mut self, packet: &[u8], expected_id: u16) -> bool {
        let Some(records) = parse(packet, expected_id) else {
            return false;
        };
        for record in records {
            let owner = if let Data::Pointer(instance) = &record.data {
                instance.clone()
            } else {
                record.name
            };
            let key = (record.kind, owner);
            if record.ttl == 0 {
                self.0.remove(&key);
            } else if self.0.len() < 1024 || self.0.contains_key(&key) {
                self.0.insert(key, record.data);
            }
        }
        true
    }

    pub(super) fn questions(&self) -> Vec<(u16, &str)> {
        let mut missing = BTreeSet::new();
        for data in self.0.values() {
            match data {
                Data::Pointer(instance) => {
                    for kind in [SRV, TXT] {
                        if !self.0.contains_key(&(kind, instance.clone())) {
                            missing.insert((kind, instance.as_str()));
                        }
                    }
                }
                Data::Service { target, .. } if !self.0.contains_key(&(A, target.clone())) => {
                    missing.insert((A, target));
                }
                _ => {}
            }
        }
        std::iter::once((PTR, SERVICE))
            .chain(missing.into_iter().take(63))
            .collect()
    }

    pub(super) fn devices(&self) -> Vec<Device> {
        let mut result = BTreeMap::new();
        for ((_, name), data) in &self.0 {
            let Data::Service { port, target } = data else {
                continue;
            };
            let Some(Data::Address(host)) = self.0.get(&(A, target.clone())) else {
                continue;
            };
            let text = self.0.get(&(TXT, name.clone())).and_then(|data| {
                if let Data::Text(text) = data {
                    Some(text)
                } else {
                    None
                }
            });
            let get = |key| {
                text.and_then(|text| text.get(key))
                    .filter(|field| !field.is_empty())
            };
            let id = get("id").cloned().unwrap_or_else(|| name.clone());
            let pretty = name.strip_suffix("._googlecast._tcp.local").unwrap_or(name);
            result.insert(
                id.clone(),
                Device {
                    id,
                    name: get("fn").map_or_else(|| pretty.to_owned(), Clone::clone),
                    model: get("md").map_or_else(|| "Chromecast".to_owned(), Clone::clone),
                    host: *host,
                    port: *port,
                },
            );
        }
        let mut devices: Vec<_> = result.into_values().collect();
        devices.sort_by(|left, right| {
            left.name
                .to_lowercase()
                .cmp(&right.name.to_lowercase())
                .then(left.id.cmp(&right.id))
        });
        devices
    }
}

pub(super) fn local_candidate(host: Ipv4Addr) -> bool {
    !host.is_unspecified()
        && !host.is_loopback()
        && !host.is_multicast()
        && !host.is_broadcast()
        && host.octets()[0] < 240
}

pub(super) fn query(id: u16, questions: &[(u16, &str)]) -> Vec<u8> {
    let mut bytes = vec![0; 12];
    bytes[..2].copy_from_slice(&id.to_be_bytes());
    let mut count = 0u16;
    for &(kind, name) in questions.iter().take(64) {
        if bytes.len() + name.len() + 6 > 1200 {
            break;
        }
        if name.is_empty()
            || name.len() > 253
            || name
                .split('.')
                .any(|label| label.is_empty() || label.len() > 63)
        {
            continue;
        }
        for label in name.split('.') {
            bytes.push(label.len() as u8);
            bytes.extend_from_slice(label.as_bytes());
        }
        bytes.push(0);
        bytes.extend_from_slice(&kind.to_be_bytes());
        bytes.extend_from_slice(&1u16.to_be_bytes());
        count += 1;
    }
    bytes[4..6].copy_from_slice(&count.to_be_bytes());
    bytes
}

fn parse(packet: &[u8], expected_id: u16) -> Option<Vec<Record>> {
    if !(12..=16_384).contains(&packet.len()) {
        return None;
    }
    let mut cursor = 0;
    if number(packet, &mut cursor)? != expected_id
        || number(packet, &mut cursor)? & 0xfa0f != 0x8000
    {
        return None;
    }
    let questions = number(packet, &mut cursor)?;
    let answers = number(packet, &mut cursor)? as usize;
    let authority = number(packet, &mut cursor)? as usize;
    let additional = number(packet, &mut cursor)? as usize;
    if questions > 64 || answers + authority + additional > 256 {
        return None;
    }
    for _ in 0..questions {
        name(packet, &mut cursor)?;
        bytes(packet, &mut cursor, 4)?;
    }
    let mut result = Vec::new();
    for index in 0..answers + authority + additional {
        let owner = name(packet, &mut cursor)?;
        let kind = number(packet, &mut cursor)?;
        let class = number(packet, &mut cursor)?;
        let ttl = u32::from_be_bytes(bytes(packet, &mut cursor, 4)?.try_into().ok()?);
        let len = number(packet, &mut cursor)? as usize;
        let start = cursor;
        let body = bytes(packet, &mut cursor, len)?;
        if (answers..answers + authority).contains(&index) || class & 0x7fff != 1 {
            continue;
        }
        if let Some(data) = record(packet, &owner, kind, ttl, start, body) {
            result.push(Record {
                kind,
                name: owner,
                ttl,
                data,
            });
        }
    }
    Some(result)
}

fn instance(name: &str) -> bool {
    name.ends_with("._googlecast._tcp.local") && name.split('.').count() == 4
}

fn record(
    packet: &[u8],
    owner: &str,
    kind: u16,
    ttl: u32,
    mut start: usize,
    body: &[u8],
) -> Option<Data> {
    let end = start + body.len();
    let valid_name = match kind {
        PTR => owner == SERVICE,
        SRV | TXT => instance(owner),
        A => owner.len() > 6 && owner.ends_with(".local"),
        _ => false,
    };
    if !valid_name {
        return None;
    }
    if ttl == 0 && kind != PTR {
        return Some(Data::Goodbye);
    }
    match kind {
        PTR => {
            let data = name(packet, &mut start)?;
            (start == end && instance(&data)).then_some(Data::Pointer(data))
        }
        SRV if body.len() >= 7 => {
            let port = u16::from_be_bytes(body[4..6].try_into().ok()?);
            start += 6;
            let target = name(packet, &mut start)?;
            (port > 0 && start == end && target.ends_with(".local"))
                .then_some(Data::Service { port, target })
        }
        TXT => Some(Data::Text(txt(body)?)),
        A => {
            let host = Ipv4Addr::from(<[u8; 4]>::try_from(body).ok()?);
            local_candidate(host).then_some(Data::Address(host))
        }
        _ => None,
    }
}

fn txt(body: &[u8]) -> Option<BTreeMap<String, String>> {
    let mut fields = BTreeMap::new();
    let mut cursor = 0;
    for _ in 0..32 {
        if cursor == body.len() {
            break;
        }
        let length = *bytes(body, &mut cursor, 1)?.first()? as usize;
        let raw = bytes(body, &mut cursor, length)?;
        let Ok(item) = std::str::from_utf8(raw) else {
            continue;
        };
        let Some((key, value)) = item.split_once('=') else {
            continue;
        };
        if matches!(key, "id" | "fn" | "md") {
            fields.insert(
                key.to_owned(),
                value
                    .chars()
                    .filter(|ch| !ch.is_control())
                    .take(200)
                    .collect(),
            );
        }
    }
    Some(fields)
}

fn name(packet: &[u8], cursor: &mut usize) -> Option<String> {
    let mut pos = *cursor;
    let mut continued = false;
    let mut output = String::new();
    for _ in 0..128 {
        let length = *packet.get(pos)?;
        if length == 0 {
            if !continued {
                *cursor = pos + 1
            }
            return Some(output);
        }
        if length & 0xc0 == 0xc0 {
            let target = (((length & 0x3f) as usize) << 8) | *packet.get(pos + 1)? as usize;
            if !(12..pos).contains(&target) {
                return None;
            }
            if !continued {
                *cursor = pos + 2;
                continued = true;
            }
            pos = target;
        } else {
            if length > 63 {
                return None;
            }
            let label =
                std::str::from_utf8(packet.get(pos + 1..pos + 1 + length as usize)?).ok()?;
            if label.contains('.') || label.chars().any(char::is_control) {
                return None;
            }
            if !output.is_empty() {
                output.push('.')
            }
            output.push_str(&label.to_ascii_lowercase());
            if output.len() > 253 {
                return None;
            }
            pos += 1 + length as usize;
        }
    }
    None
}

fn number(packet: &[u8], cursor: &mut usize) -> Option<u16> {
    Some(u16::from_be_bytes(
        bytes(packet, cursor, 2)?.try_into().ok()?,
    ))
}

fn bytes<'a>(packet: &'a [u8], cursor: &mut usize, len: usize) -> Option<&'a [u8]> {
    let end = cursor.checked_add(len)?;
    let value = packet.get(*cursor..end)?;
    *cursor = end;
    Some(value)
}
