use super::mirror::Ingress;
use crate::local_player::{byte_range, Grant};
use std::{
    io,
    net::Ipv4Addr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinSet,
};

const PLAYER: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/chrome-player.js"));
const LIMIT: usize = 8192;
const MAX_REQUESTS: usize = 6;
type Media = Arc<Mutex<Content>>;

#[derive(Default)]
struct Content {
    file: Option<(String, Arc<Grant>)>,
    mirror: Option<(String, Arc<Ingress>)>,
}

pub(super) struct Host {
    pub url: String,
    media: Media,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl Host {
    pub fn open() -> io::Result<Self> {
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let address = listener.local_addr()?.to_string();
        let token = uuid::Uuid::new_v4().simple().to_string();
        let url = format!("http://{address}/{token}/");
        let media: Media = Arc::default();
        let task = tauri::async_runtime::spawn(serve(listener, address, token, media.clone()));
        Ok(Self { url, media, task })
    }

    pub fn grant(&self, file: Arc<Grant>) -> String {
        let key = format!("video-{}", uuid::Uuid::new_v4().simple());
        self.media
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .file = Some((key.clone(), file));
        format!("{}{key}", self.url)
    }

    pub fn mirror(&self, ingress: Arc<Ingress>) -> String {
        let key = format!("mirror-{}", uuid::Uuid::new_v4().simple());
        self.media
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .mirror = Some((key.clone(), ingress));
        format!("{}{key}", self.url)
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn serve(socket: std::net::TcpListener, address: String, token: String, media: Media) {
    let Ok(listener) = TcpListener::from_std(socket) else {
        return;
    };
    let mut tasks = JoinSet::new();
    let page = Arc::new(format!("<!doctype html><meta charset=utf-8><title>AniVerse · Chrome Cast</title><body><script src=\"/{token}/player.js\"></script></body>"));
    let root = Arc::new(format!("/{token}/"));
    let host = Arc::new(address);
    while let Ok((stream, peer)) = listener.accept().await {
        while tasks.try_join_next().is_some() {}
        if peer.ip().is_loopback() && tasks.len() < MAX_REQUESTS {
            tasks.spawn(serve_one(
                stream,
                host.clone(),
                root.clone(),
                page.clone(),
                media.clone(),
            ));
        }
    }
}

async fn serve_one(
    mut stream: TcpStream,
    host: Arc<String>,
    root: Arc<String>,
    page: Arc<String>,
    media: Media,
) {
    let _ = tokio::time::timeout(
        Duration::from_secs(90),
        request(&mut stream, &host, &root, &page, &media),
    )
    .await;
}

async fn request(
    stream: &mut TcpStream,
    host: &str,
    root: &str,
    page: &str,
    media: &Media,
) -> io::Result<()> {
    let mut buffer = [0; LIMIT];
    let len = tokio::time::timeout(Duration::from_secs(3), read_header(stream, &mut buffer))
        .await
        .map_err(io::Error::other)??;
    let mut headers = [httparse::EMPTY_HEADER; 32];
    let mut request = httparse::Request::new(&mut headers);
    if !request
        .parse(&buffer[..len])
        .is_ok_and(|status| status.is_complete())
        || !matches!(request.method, Some("GET" | "HEAD"))
        || request
            .headers
            .iter()
            .filter(|header| header.name.eq_ignore_ascii_case("host"))
            .map(|header| header.value)
            .collect::<Vec<_>>()
            != [host.as_bytes()]
    {
        return not_found(stream).await;
    }
    let head = request.method == Some("HEAD");
    let Some(name) = request.path.and_then(|path| path.strip_prefix(root)) else {
        return not_found(stream).await;
    };
    let fixed = match name {
        "" => Some(("text/html; charset=utf-8", page.as_bytes())),
        "player.js" => Some(("text/javascript; charset=utf-8", PLAYER)),
        _ => None,
    };
    if let Some((mime, bytes)) = fixed {
        let header = format!("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self' http: https:; media-src 'self' http: https: blob:; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'\r\n\r\n", bytes.len());
        stream.write_all(header.as_bytes()).await?;
        if !head {
            stream.write_all(bytes).await?;
        }
        return Ok(());
    }
    if request.headers.iter().any(|header| {
        header.name.eq_ignore_ascii_case("origin")
            && header.value != format!("http://{host}").as_bytes()
    }) {
        return not_found(stream).await;
    }
    if let Some((name, after)) = name.split_once("?after=") {
        let mirror = media
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .mirror
            .as_ref()
            .filter(|(key, _)| key == name)
            .map(|(_, ingress)| ingress.clone());
        if let (Some(ingress), Ok(after)) = (mirror, after.parse::<u64>()) {
            return send_frame(stream, &ingress, after, head).await;
        }
        return not_found(stream).await;
    }
    let file = media
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .file
        .as_ref()
        .filter(|(key, _)| key == name)
        .map(|(_, file)| file.clone());
    let Some(file) = file else {
        return not_found(stream).await;
    };
    let range = request
        .headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case("range"))
        .map(|header| {
            std::str::from_utf8(header.value)
                .ok()
                .and_then(|value| byte_range(value, file.size()))
        });
    send_video(stream, file, range, head).await
}

async fn send_frame(
    stream: &mut TcpStream,
    ingress: &Ingress,
    after: u64,
    head: bool,
) -> io::Result<()> {
    if ingress.is_closed() || ingress.expired() {
        return stream.write_all(b"HTTP/1.1 410 Gone\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n").await;
    }
    let Some(frame) = ingress.latest(after) else {
        return stream
            .write_all(
                b"HTTP/1.1 204 No Content\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
            )
            .await;
    };
    let response = format!("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: image/jpeg\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Sequence: {}\r\nContent-Length: {}\r\n\r\n", frame.sequence, frame.jpeg.len());
    if ingress.is_closed() {
        return Ok(());
    }
    stream.write_all(response.as_bytes()).await?;
    if !head && !ingress.is_closed() {
        stream.write_all(&frame.jpeg).await?;
    }
    Ok(())
}

async fn read_header(stream: &mut TcpStream, buffer: &mut [u8]) -> io::Result<usize> {
    let mut size = 0;
    while size < buffer.len() {
        let bytes = stream.read(&mut buffer[size..]).await?;
        if bytes == 0 {
            break;
        }
        size += bytes;
        if buffer[..size].windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            return Ok(size);
        }
    }
    Err(io::ErrorKind::InvalidData.into())
}

async fn not_found(stream: &mut TcpStream) -> io::Result<()> {
    stream
        .write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
        .await
}

async fn send_video(
    stream: &mut TcpStream,
    file: Arc<Grant>,
    range: Option<Option<(u64, u64)>>,
    head: bool,
) -> io::Result<()> {
    let size = file.size();
    let (start, end, status, extra) = match range {
        Some(Some((start, end))) => (
            start,
            end,
            "206 Partial Content",
            format!("Content-Range: bytes {start}-{end}/{size}\r\n"),
        ),
        Some(None) => {
            return stream.write_all(format!("HTTP/1.1 416 Range Not Satisfiable\r\nConnection: close\r\nContent-Range: bytes */{size}\r\nContent-Length: 0\r\n\r\n").as_bytes()).await;
        }
        None => (0, size - 1, "200 OK", String::new()),
    };
    let header = format!("HTTP/1.1 {status}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Type: {}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n{extra}\r\n", file.mime(), end - start + 1);
    stream.write_all(header.as_bytes()).await?;
    if head {
        return Ok(());
    }
    let mut position = start;
    while position <= end {
        let length = (end - position + 1).min(256 * 1024) as usize;
        let handle = file.clone();
        let bytes = tauri::async_runtime::spawn_blocking(move || {
            let mut bytes = vec![0; length];
            handle.read_at(position, &mut bytes)?;
            Ok::<_, io::Error>(bytes)
        })
        .await
        .map_err(io::Error::other)??;
        stream.write_all(&bytes).await?;
        position += length as u64;
    }
    Ok(())
}
