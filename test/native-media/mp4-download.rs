use super::*;
use aniverse_security::{allows_public_address, allows_public_mp4};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    thread::{self, JoinHandle},
};

fn fixture(marker: u8) -> Vec<u8> {
    let mut bytes = vec![marker; 4096];
    bytes[..24].copy_from_slice(b"\x00\x00\x00\x18ftypisom\x00\x00\x00\x00isommp42");
    bytes
}

fn server(run: impl FnOnce(TcpListener) + Send + 'static) -> (Url, JoinHandle<()>) {
    let socket = TcpListener::bind("127.0.0.1:0").unwrap();
    socket.set_nonblocking(true).unwrap();
    let address: SocketAddr = socket.local_addr().unwrap();
    (
        Url::parse(&format!("http://{address}/clip.mp4")).unwrap(),
        thread::spawn(move || run(socket)),
    )
}

fn request(listener: &TcpListener) -> (TcpStream, String) {
    let start = Instant::now();
    let stream = loop {
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(error)
                if error.kind() == io::ErrorKind::WouldBlock
                    && start.elapsed() < Duration::from_secs(5) =>
            {
                thread::sleep(Duration::from_millis(15));
            }
            Err(error) => panic!("missing expected request: {error}"),
        }
    };
    // Windows can inherit the listener nonblocking mode on an accepted socket.
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut reader = BufReader::new(&stream);
    let mut headers = String::new();
    loop {
        let mut line = String::new();
        assert_ne!(reader.read_line(&mut line).unwrap(), 0);
        if line == "\r\n" {
            break;
        }
        headers.push_str(&line.to_ascii_lowercase());
    }
    assert!(!headers.contains("cookie:"));
    assert!(!headers.contains("authorization:"));
    assert!(headers.contains("accept-encoding: identity"));
    drop(reader);
    (stream, headers)
}

fn reply(mut socket: TcpStream, status: &str, total: usize, extra: &str, body: &[u8]) {
    write!(socket, "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Type: video/mp4\r\nContent-Length: {total}\r\n{extra}\r\n").unwrap();
    socket.write_all(body).unwrap();
    socket.flush().unwrap();
    thread::sleep(Duration::from_millis(35));
}

fn folder() -> tempfile::TempDir {
    let root = std::env::var_os("ANIVERSE2_MP4_VALIDATION_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/cache/aniverse2")
        });
    fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root).unwrap()
}

fn download(url: &Url, to: &Path) -> Result<(), RpcError> {
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(8))
        .build()
        .unwrap();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(save(&client, url, to, |_, _| {}))
}

#[test]
fn resumes_interrupted_mp4_with_exact_range_and_strong_validator() {
    let bytes = fixture(65);
    let expected = bytes.clone();
    let (url, worker) = server(move |listener| {
        let (socket, headers) = request(&listener);
        assert!(!headers.contains("\r\nrange:"));
        reply(
            socket,
            "200 OK",
            bytes.len(),
            "ETag: \"fixture-a\"\r\n",
            &bytes[..1024],
        );
        let (socket, headers) = request(&listener);
        assert!(headers.contains("range: bytes=1024-"));
        assert!(headers.contains("if-range: \"fixture-a\""));
        reply(
            socket,
            "206 Partial Content",
            bytes.len() - 1024,
            "ETag: \"fixture-a\"\r\nContent-Range: bytes 1024-4095/4096\r\n",
            &bytes[1024..],
        );
    });
    let dir = folder();
    let to = dir.path().join("clip.mp4");
    download(&url, &to).unwrap();
    worker.join().unwrap();
    assert_eq!(fs::read(to).unwrap(), expected);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn discards_changed_range_and_restarts_without_clobbering_existing_file() {
    let dir = folder();
    let raced = dir.path().join("race.mp4");
    let concurrent = raced.clone();
    let bytes = fixture(66);
    let expected = bytes.clone();
    let (url, worker) = server(move |listener| {
        let (socket, _) = request(&listener);
        reply(
            socket,
            "200 OK",
            bytes.len(),
            "ETag: \"fixture-a\"\r\n",
            &bytes[..1024],
        );
        let (socket, headers) = request(&listener);
        assert!(headers.contains("range: bytes=1024-"));
        reply(
            socket,
            "206 Partial Content",
            bytes.len() - 1024,
            "ETag: \"fixture-b\"\r\nContent-Range: bytes 1024-4095/4096\r\n",
            &bytes[1024..],
        );
        let (socket, headers) = request(&listener);
        assert!(!headers.contains("\r\nrange:"));
        reply(
            socket,
            "200 OK",
            bytes.len(),
            "ETag: \"fixture-b\"\r\n",
            &bytes,
        );
        let (socket, headers) = request(&listener);
        assert!(headers.starts_with("get /race.mp4 "));
        fs::write(concurrent, b"Concurrent destination").unwrap();
        reply(socket, "200 OK", bytes.len(), "", &fixture(88));
    });
    let to = dir.path().join("clip.mp4");
    download(&url, &to).unwrap();
    assert_eq!(download(&url, &to).unwrap_err().code, "config");
    assert_eq!(
        download(&url.join("race.mp4").unwrap(), &raced)
            .unwrap_err()
            .code,
        "config"
    );
    worker.join().unwrap();
    assert_eq!(fs::read(to).unwrap(), expected);
    assert_eq!(fs::read(raced).unwrap(), b"Concurrent destination");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
}

#[test]
fn rejects_non_mp4_payload_and_forbids_private_or_cross_source_links() {
    assert!(!allows_public_mp4(
        "https://127.0.0.1/clip.mp4",
        "https://127.0.0.1"
    ));
    assert!(!allows_public_mp4(
        "https://example.org/clip.mp4",
        "https://example.net"
    ));
    assert!(!allows_public_mp4(
        "https://example.org/stream.m3u8",
        "https://example.org"
    ));
    assert!(!allows_public_address("169.254.169.254".parse().unwrap()));
    assert!(allows_public_mp4(
        "https://example.org/clip.mp4",
        "https://example.org"
    ));
    let (url, worker) = server(move |listener| {
        let (socket, _) = request(&listener);
        let fake = [b'<'; HEADER_LIMIT];
        reply(socket, "200 OK", fake.len() * 2, "", &fake);
    });
    let dir = folder();
    let to = dir.path().join("clip.mp4");
    assert_eq!(download(&url, &to).unwrap_err().code, "invalid-input");
    worker.join().unwrap();
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
}
