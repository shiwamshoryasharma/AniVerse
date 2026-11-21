use serde_json::Value;
use std::io;

pub(super) const MAX_FRAME: usize = 1024 * 1024;

pub(super) struct Message {
    pub source: String,
    pub destination: String,
    pub namespace: String,
    pub payload: Value,
}

pub(super) fn frame(message: &Message) -> io::Result<Vec<u8>> {
    let payload = serde_json::to_string(&message.payload).map_err(|_| invalid())?;
    let mut body = vec![8, 0, 40, 0]; // CASTV2_1_0, string payload
    for (field, value) in [
        (2, message.source.as_str()),
        (3, message.destination.as_str()),
        (4, message.namespace.as_str()),
        (6, payload.as_str()),
    ] {
        if value.len() > MAX_FRAME {
            return Err(invalid());
        }
        body.push((field << 3) | 2);
        let mut length = value.len();
        while length >= 128 {
            body.push((length as u8 & 127) | 128);
            length >>= 7;
        }
        body.push(length as u8);
        body.extend(value.as_bytes());
    }
    if body.len() > MAX_FRAME {
        return Err(invalid());
    }
    let mut result = Vec::with_capacity(body.len() + 4);
    result.extend((body.len() as u32).to_be_bytes());
    result.extend(body);
    Ok(result)
}

pub(super) fn decode(mut body: &[u8]) -> io::Result<Option<Message>> {
    let mut fields = [None; 7];
    let mut payload_type = None;
    let mut version = None;
    while !body.is_empty() {
        let tag = varint(&mut body)?;
        let field = tag >> 3;
        if field == 0 || tag > u32::MAX.into() {
            return Err(invalid());
        }
        match tag & 7 {
            0 => {
                let value = varint(&mut body)?;
                if field == 1 {
                    version = Some(value);
                }
                if field == 5 {
                    payload_type = Some(value);
                }
            }
            1 => {
                take(&mut body, 8)?;
            }
            2 => {
                let size = usize::try_from(varint(&mut body)?).map_err(|_| invalid())?;
                let value = take(&mut body, size)?;
                if matches!(field, 2 | 3 | 4 | 6) {
                    fields[field as usize] = Some(value);
                }
            }
            5 => {
                take(&mut body, 4)?;
            }
            _ => return Err(invalid()),
        }
    }
    if version != Some(0) || payload_type != Some(0) {
        return Ok(None);
    }
    let text = |field: usize| {
        let bytes = fields[field].ok_or_else(invalid)?;
        if bytes.is_empty() || bytes.len() > 256 {
            return Err(invalid());
        }
        String::from_utf8(bytes.to_vec()).map_err(|_| invalid())
    };
    let payload: Value =
        serde_json::from_slice(fields[6].ok_or_else(invalid)?).map_err(|_| invalid())?;
    if !payload.is_object() {
        return Err(invalid());
    }
    Ok(Some(Message {
        source: text(2)?,
        destination: text(3)?,
        namespace: text(4)?,
        payload,
    }))
}

fn take<'a>(input: &mut &'a [u8], count: usize) -> io::Result<&'a [u8]> {
    if count > input.len() {
        return Err(invalid());
    }
    let (value, rest) = input.split_at(count);
    *input = rest;
    Ok(value)
}

fn varint(input: &mut &[u8]) -> io::Result<u64> {
    let mut value = 0;
    for shift in (0..=63).step_by(7) {
        let byte = take(input, 1)?[0];
        if shift == 63 && byte > 1 {
            return Err(invalid());
        }
        value |= u64::from(byte & 127) << shift;
        if byte < 128 {
            return Ok(value);
        }
    }
    Err(invalid())
}

pub(super) fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "Invalid Cast receiver message.")
}

#[cfg(test)]
#[path = "../../../../test/tauri-compat/cast-wire.rs"]
mod tests;
