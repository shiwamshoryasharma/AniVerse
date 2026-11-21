mod records;

use crate::RpcError;
use records::{local_candidate, Device, Records};
use serde_json::Value;
use socket2::{Domain, Protocol, SockRef, Socket, Type};
use std::{
    io,
    mem::{offset_of, size_of},
    net::{IpAddr, Ipv4Addr, SocketAddrV4, UdpSocket},
    sync::Mutex,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS},
    NetworkManagement::IpHelper::{GetIpAddrTable, MIB_IPADDRROW_XP, MIB_IPADDRTABLE},
};

const GROUP: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 251);
const PORT: u16 = 5353;
static SCANNING: Mutex<()> = Mutex::new(());

pub(crate) async fn scan() -> Result<Value, RpcError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _scan = SCANNING
            .try_lock()
            .map_err(|_| RpcError::new("unavailable", "A Cast scan is already running."))?;
        serde_json::to_value(discover()?).map_err(|_| network())
    })
    .await
    .map_err(|_| network())?
}

fn discover() -> Result<Vec<Device>, RpcError> {
    let mut interfaces = interfaces().map_err(|_| network())?;
    if interfaces.is_empty() {
        return Err(RpcError::new(
            "unavailable",
            "No local IPv4 network is available for Google Cast discovery.",
        ));
    }
    let (socket, legacy) = bind(&mut interfaces).map_err(|_| network())?;
    let transaction = if legacy {
        (uuid::Uuid::new_v4().as_u128() as u16).max(1)
    } else {
        0
    };
    let mut records = Records::default();
    send_queries(&socket, &interfaces, &records, transaction).map_err(|_| network())?;
    let mut buffer = [0u8; 16_385];
    let mut query_at = Instant::now() + Duration::from_secs(1);
    let end = Instant::now() + Duration::from_secs(5);
    while Instant::now() < end {
        match socket.recv_from(&mut buffer) {
            Ok((len, peer)) if peer.port() == PORT && on_link(&interfaces, peer.ip()) => {
                records.add(&buffer[..len], transaction);
            }
            Ok(_) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) => {}
            Err(error) if error.raw_os_error() == Some(10040) => {} // Truncated oversized UDP datagram.
            Err(_) => return Err(network()),
        }
        if Instant::now() >= query_at {
            send_queries(&socket, &interfaces, &records, transaction).map_err(|_| network())?;
            query_at = Instant::now() + Duration::from_secs(1);
        }
    }
    Ok(records
        .devices()
        .into_iter()
        .filter(|device| on_link(&interfaces, IpAddr::V4(device.host)))
        .collect())
}

fn bind(interfaces: &mut Vec<Interface>) -> io::Result<(UdpSocket, bool)> {
    let make = || -> io::Result<Socket> {
        let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
        socket.set_read_timeout(Some(Duration::from_millis(200)))?;
        socket.set_multicast_ttl_v4(255)?;
        socket.set_multicast_loop_v4(false)?;
        Ok(socket)
    };
    let socket = make()?;
    socket.set_reuse_address(true)?;
    if socket
        .bind(&SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, PORT).into())
        .is_ok()
    {
        let joined: Vec<_> = interfaces
            .iter()
            .copied()
            .filter(|scope| socket.join_multicast_v4(&GROUP, &scope.host).is_ok())
            .collect();
        if !joined.is_empty() {
            *interfaces = joined;
            return Ok((socket.into(), false));
        }
    }
    // Windows may already reserve 5353. An ephemeral source port requests
    // standards-compliant unicast responses and avoids taking over any service.
    let legacy = make()?;
    legacy.bind(&SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0).into())?;
    Ok((legacy.into(), true))
}

fn send_queries(
    socket: &UdpSocket,
    interfaces: &[Interface],
    records: &Records,
    id: u16,
) -> io::Result<()> {
    let msg = records::query(id, &records.questions());
    let handle = SockRef::from(socket);
    let address = SocketAddrV4::new(GROUP, PORT);
    let mut sent = false;
    for scope in interfaces {
        if handle.set_multicast_if_v4(&scope.host).is_ok() {
            sent |= socket.send_to(&msg, address).is_ok();
        }
    }
    if sent {
        Ok(())
    } else {
        Err(io::ErrorKind::AddrNotAvailable.into())
    }
}

#[derive(Clone, Copy)]
struct Interface {
    host: Ipv4Addr,
    mask: u32,
}

fn on_link(interfaces: &[Interface], peer: IpAddr) -> bool {
    let IpAddr::V4(peer) = peer else { return false };
    local_candidate(peer)
        && interfaces.iter().any(|scope| {
            let peer = u32::from(peer);
            let known = u32::from(scope.host);
            (peer & scope.mask) == (known & scope.mask)
        })
}

fn interfaces() -> io::Result<Vec<Interface>> {
    let mut size = 0u32;
    unsafe {
        GetIpAddrTable(std::ptr::null_mut(), &mut size, 0);
    }
    for _ in 0..3 {
        if !(4..=256 * 1024).contains(&size) {
            break;
        }
        let mut storage = vec![0u32; (size as usize).div_ceil(size_of::<u32>())];
        let status =
            unsafe { GetIpAddrTable(storage.as_mut_ptr().cast::<MIB_IPADDRTABLE>(), &mut size, 0) };
        if status == ERROR_INSUFFICIENT_BUFFER {
            continue;
        }
        if status != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        let capacity = storage.len() * size_of::<u32>();
        let start = offset_of!(MIB_IPADDRTABLE, table);
        let count = storage[0] as usize;
        if count > (capacity - start) / size_of::<MIB_IPADDRROW_XP>() {
            break;
        }
        // The system returned a bounded, aligned contiguous array of C records.
        let first = unsafe {
            storage
                .as_ptr()
                .cast::<u8>()
                .add(start)
                .cast::<MIB_IPADDRROW_XP>()
        };
        let rows = unsafe { std::slice::from_raw_parts(first, count) };
        let mut result: Vec<Interface> = Vec::new();
        for row in rows {
            let host = Ipv4Addr::from(row.dwAddr.to_ne_bytes());
            let mask = u32::from_be_bytes(row.dwMask.to_ne_bytes());
            if local_candidate(host)
                && !host.is_link_local()
                && mask != 0
                && !result.iter().any(|scope| scope.host == host)
            {
                result.push(Interface { host, mask });
                if result.len() == 16 {
                    break;
                }
            }
        }
        return Ok(result);
    }
    Err(io::ErrorKind::InvalidData.into())
}

fn network() -> RpcError {
    RpcError::new("unavailable", "Google Cast discovery could not use the network. Check your Windows firewall, VPN, or IPv4 connection.")
}

#[cfg(test)]
#[path = "../../../../test/tauri-compat/cast-discovery/fixture.rs"]
mod tests;
