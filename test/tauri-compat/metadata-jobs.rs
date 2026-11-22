use super::*;
use std::path::PathBuf;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    thread::{self, JoinHandle},
};

struct Server {
    endpoint: String,
    calls: Arc<AtomicUsize>,
    maximum: Arc<AtomicUsize>,
    release: Arc<AtomicBool>,
    success: Arc<AtomicBool>,
    rate_limited: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}
impl Server {
    fn new(held: bool, successful: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let calls = Arc::new(AtomicUsize::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(AtomicBool::new(!held));
        let success = Arc::new(AtomicBool::new(successful));
        let rate_limited = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let (count, current, peak, ready, ok, done) = (
            calls.clone(),
            active,
            maximum.clone(),
            release.clone(),
            success.clone(),
            stop.clone(),
        );
        let limited = rate_limited.clone();
        let thread = thread::spawn(move || {
            let mut workers = Vec::new();
            while !done.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let limited = limited.clone();
                        let (count, current, peak, ready, ok) = (
                            count.clone(),
                            current.clone(),
                            peak.clone(),
                            ready.clone(),
                            ok.clone(),
                        );
                        workers.push(thread::spawn(move || {
                            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                            let mut request = Vec::new();
                            let mut buffer = [0; 8192];
                            loop {
                                let read = match stream.read(&mut buffer) { Ok(read) => read, Err(_) => return };
                                if read == 0 { return; }
                                request.extend_from_slice(&buffer[..read]);
                                assert!(request.len() < 65536);
                                if let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                                    let headers = String::from_utf8_lossy(&request[..end]);
                                    let length = headers.lines().find_map(|line| {
                                        let (name, value) = line.split_once(':')?;
                                        name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().unwrap())
                                    }).unwrap_or(0);
                                    if request.len() >= end + 4 + length { break; }
                                }
                            }
                            count.fetch_add(1, Ordering::AcqRel);
                            let running = current.fetch_add(1, Ordering::AcqRel) + 1;
                            peak.fetch_max(running, Ordering::AcqRel);
                            while !ready.load(Ordering::Acquire) { thread::sleep(Duration::from_millis(2)); }
                            thread::sleep(Duration::from_millis(20));
                            let (status, body) = if limited.load(Ordering::Acquire) {
                                ("429 Too Many Requests", r#"{"errors":[{"message":"rate fixture"}]}"#)
                            } else if ok.load(Ordering::Acquire) {
                                ("200 OK", r#"{"data":{"GenreCollection":["Action"],"MediaTagCollection":[]}}"#)
                            } else { ("503 Service Unavailable", r#"{"errors":[{"message":"offline fixture"}]}"#) };
                            let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nRetry-After: 1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                            let _ = stream.write_all(response.as_bytes());
                            current.fetch_sub(1, Ordering::AcqRel);
                            // Finish the fixture's HTTP/1 close handshake before dropping the Windows socket.
                            let _ = stream.shutdown(std::net::Shutdown::Write);
                            let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
                            while let Ok(read) = stream.read(&mut buffer) { if read == 0 { break; } }
                        }));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(error) => panic!("fixture accept: {error}"),
                }
            }
            for worker in workers {
                worker.join().unwrap();
            }
        });
        Self {
            endpoint,
            calls,
            maximum,
            release,
            success,
            rate_limited,
            stop,
            thread: Some(thread),
        }
    }
    fn client(&self) -> Arc<Client> {
        let mut client = Client::new().unwrap();
        client.http = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        client.test_endpoint = self.endpoint.clone();
        Arc::new(client)
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.release.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}
async fn wait_calls(server: &Server, count: usize) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while server.calls.load(Ordering::Acquire) < count {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}
#[test]
fn failed_fanout_is_shared_and_recovers_after_healer_cooldown() {
    let server = Server::new(false, false);
    let client = server.client();
    tauri::async_runtime::block_on(async {
        let jobs: Vec<_> = (0..12)
            .map(|_| {
                let client = client.clone();
                tauri::async_runtime::spawn(async move {
                    client.get(Request::Genres, false, vec![]).await
                })
            })
            .collect();
        for job in jobs {
            assert_eq!(job.await.unwrap().unwrap_err().code, "network");
        }
        assert_eq!(
            server.calls.load(Ordering::Acquire),
            1,
            "failed duplicates must share one worker result"
        );
        assert!(client.get(Request::Genres, false, vec![]).await.is_err());
        assert_eq!(
            server.calls.load(Ordering::Acquire),
            1,
            "cooldown must not create another worker"
        );
        server.success.store(true, Ordering::Release);
        tokio::time::sleep(Duration::from_millis(2100)).await;
        let recovered = client.get(Request::Genres, false, vec![]).await.unwrap();
        assert_eq!(recovered["genres"], json!(["Action"]));
        assert_eq!(server.calls.load(Ordering::Acquire), 2);
    });
}
#[test]
fn slow_workers_are_bounded_and_do_not_block_settings_or_async_heartbeats() {
    let server = Server::new(true, true);
    let client = server.client();
    let root =
        tempfile::tempdir_in(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/cache"))
            .unwrap();
    tauri::async_runtime::block_on(async {
        let jobs: Vec<_> = (0..32)
            .map(|id| {
                let client = client.clone();
                tauri::async_runtime::spawn(async move {
                    client.get(Request::Genres, false, vec![id]).await
                })
            })
            .collect();
        wait_calls(&server, 4).await;
        tokio::time::timeout(Duration::from_secs(1), async {
            while client.pending.available_permits() != 0 {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            client
                .get(Request::Genres, false, vec![99])
                .await
                .unwrap_err()
                .code,
            "rate-limited"
        );
        client.cache().insert(
            (Request::Genres, false, vec![-1]),
            60,
            json!({"cached":true}),
        );
        assert_eq!(
            client.get(Request::Genres, false, vec![-1]).await.unwrap(),
            json!({"cached":true}),
            "busy workers must not block an already cached result"
        );
        let path = root.path().to_owned();
        let settings = tokio::time::timeout(
            Duration::from_millis(500),
            tauri::async_runtime::spawn_blocking(move || {
                crate::profile::request(&path, "settings.get", Value::Null)
            }),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        assert!(settings["appearance"].is_object());
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(server.calls.load(Ordering::Acquire), 4);
        server.release.store(true, Ordering::Release);
        for job in jobs {
            job.await.unwrap().unwrap();
        }
        assert!(server.maximum.load(Ordering::Acquire) <= 4);
    });
}
#[test]
fn manager_discards_results_from_a_cancelled_generation() {
    let server = Server::new(true, true);
    let client = server.client();
    tauri::async_runtime::block_on(async {
        let worker = client.clone();
        let job =
            tauri::async_runtime::spawn(
                async move { worker.get(Request::Genres, false, vec![]).await },
            );
        wait_calls(&server, 1).await;
        client.clear_cache();
        let result = tokio::time::timeout(Duration::from_millis(250), job)
            .await
            .expect("manager cancellation must release a blocked worker promptly")
            .unwrap();
        server.release.store(true, Ordering::Release);
        assert!(
            result.is_err(),
            "cancelled generation must not publish its old result"
        );
        assert_eq!(result.unwrap_err().code, "cancelled");
        assert!(client.cache().entries.is_empty());
    });
}

#[test]
fn manager_honours_worker_retry_after_across_distinct_jobs_without_an_internal_retry_loop() {
    let server = Server::new(false, false);
    server.rate_limited.store(true, Ordering::Release);
    let client = server.client();
    tauri::async_runtime::block_on(async {
        assert_eq!(
            client
                .get(Request::Genres, false, vec![1])
                .await
                .unwrap_err()
                .code,
            "rate-limited"
        );
        assert_eq!(
            client
                .get(Request::Genres, false, vec![2])
                .await
                .unwrap_err()
                .code,
            "rate-limited"
        );
        assert_eq!(server.calls.load(Ordering::Acquire), 1);
        server.rate_limited.store(false, Ordering::Release);
        server.success.store(true, Ordering::Release);
        tokio::time::sleep(Duration::from_millis(1100)).await;
        assert!(client.get(Request::Genres, false, vec![3]).await.is_ok());
        assert_eq!(server.calls.load(Ordering::Acquire), 2);
    });
}

#[test]
fn manager_cancellation_releases_running_and_queued_jobs_without_starting_more_requests() {
    let server = Server::new(true, true);
    let client = server.client();
    tauri::async_runtime::block_on(async {
        let jobs: Vec<_> = (0..5)
            .map(|id| {
                let client = client.clone();
                tauri::async_runtime::spawn(async move {
                    client.get(Request::Genres, false, vec![id]).await
                })
            })
            .collect();
        wait_calls(&server, 4).await;
        tokio::time::timeout(Duration::from_secs(1), async {
            while client.pending.available_permits() != MAX_PENDING - 5 {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap();
        client.clear_cache();
        tokio::time::timeout(Duration::from_millis(250), async {
            for job in jobs {
                assert_eq!(job.await.unwrap().unwrap_err().code, "cancelled");
            }
        })
        .await
        .expect("manager cancellation must free both worker and queue slots");
        server.release.store(true, Ordering::Release);
        assert_eq!(server.calls.load(Ordering::Acquire), 4);
        assert_eq!(client.pending.available_permits(), MAX_PENDING);
        assert_eq!(client.outbound.available_permits(), 4);
    });
}
