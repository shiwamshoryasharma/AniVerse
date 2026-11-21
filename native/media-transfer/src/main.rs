mod hls;
mod remux;
mod transfer;

use aniverse_security::allows_public_address;
use reqwest::{redirect::Policy, Client, Url};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, Read, Write},
    net::IpAddr,
    path::PathBuf,
    process::ExitCode,
    time::Duration,
};
use tokio::{net::lookup_host, time::timeout};

#[derive(Debug)]
struct RpcError {
    code: &'static str,
    message: String,
}

impl RpcError {
    fn new(code: &'static str, message: &str) -> Self {
        Self {
            code,
            message: message.to_owned(),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    url: String,
    observed: Option<String>,
    destination: PathBuf,
}

fn main() -> ExitCode {
    let result = run();
    match result {
        Ok(()) => publish(json!({"done": true})),
        Err(error) => {
            publish(json!({"error": error.message, "code": error.code}));
            return ExitCode::FAILURE;
        }
    }
    ExitCode::SUCCESS
}

fn run() -> Result<(), RpcError> {
    const REQUEST_LIMIT: u64 = 24 * 1024;
    let mut bytes = Vec::new();
    io::stdin()
        .lock()
        .take(REQUEST_LIMIT + 1)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| invalid("Could not read the download request."))?;
    if bytes.len() > REQUEST_LIMIT as usize {
        return Err(invalid("The download request is too large."));
    }
    let request: Request =
        serde_json::from_slice(&bytes).map_err(|_| invalid("The download request is invalid."))?;
    if !request.destination.is_absolute()
        || !request
            .destination
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("mp4"))
    {
        return Err(invalid("Choose an absolute destination ending in .mp4."));
    }
    let url = media_url(&request.url)
        .ok_or_else(|| invalid("Choose a clear public MP4 or HLS stream."))?;
    let observed = request
        .observed
        .as_deref()
        .map(|value| {
            Url::parse(value)
                .ok()
                .filter(|url| public_media_url(url))
                .ok_or_else(|| invalid("The active video reference is invalid."))
        })
        .transpose()?;
    let hls = has_extension(&url, "m3u8");
    if observed.is_some() && !hls {
        return Err(invalid(
            "The active video reference does not match the transfer.",
        ));
    }
    let ffmpeg = if hls {
        bind_remux_process_tree()?;
        Some(
            std::env::current_exe()
                .ok()
                .and_then(|file| file.parent().map(|folder| folder.join("ffmpeg.exe")))
                .filter(|file| file.is_file())
                .ok_or_else(|| invalid("The bundled MP4 remuxer is missing."))?,
        )
    } else {
        None
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| invalid("Could not start the download worker."))?;
    let transfer = runtime.spawn(async move {
        let transport = public_transport(&url).await?;
        let progress = |received, total| publish(json!({"received": received, "total": total}));
        timeout(Duration::from_secs(45 * 60), async {
            if let Some(ffmpeg) = ffmpeg.as_ref() {
                remux::save(
                    &transport,
                    &url,
                    observed.as_ref(),
                    &request.destination,
                    ffmpeg,
                    progress,
                )
                .await
            } else {
                transfer::save(&transport, &url, &request.destination, progress).await
            }
        })
        .await
        .map_err(|_| invalid("The MP4 download timed out."))?
    });
    let cancel = transfer.abort_handle();
    std::thread::spawn(move || {
        // The host keeps the pipe open during the transfer. Closing it cancels
        // the Rust future so its temp files and remux subprocess are cleaned up.
        let _ = io::stdin().read(&mut [0]);
        cancel.abort();
    });
    runtime
        .block_on(transfer)
        .map_err(|_| invalid("The MP4 download was interrupted."))?
}

fn publish(event: Value) {
    let mut stdout = io::stdout().lock();
    let _ = writeln!(stdout, "{event}");
    let _ = stdout.flush();
}

#[cfg(windows)]
fn bind_remux_process_tree() -> Result<(), RpcError> {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::GetCurrentProcess,
        },
    };
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err(invalid("Could not protect the MP4 remux process."));
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&limits) as u32,
        ) == 0
            || AssignProcessToJobObject(job, GetCurrentProcess()) == 0
        {
            CloseHandle(job);
            return Err(invalid("Could not protect the MP4 remux process."));
        }
        // Keep this non-inheritable job handle until process exit, so cancellation
        // by the host also terminates an in-flight FFmpeg child.
        Ok(())
    }
}

fn media_url(input: &str) -> Option<Url> {
    Url::parse(input).ok().filter(is_active_media_url)
}

#[cfg(feature = "isolated-test")]
fn fixture_source(url: &Url) -> bool {
    url.scheme() == "http"
        && url.port().is_some()
        && url
            .host_str()
            .and_then(|value| value.trim_matches(['[', ']']).parse::<IpAddr>().ok())
            .is_some_and(|ip| ip.is_loopback())
        && std::env::var("ANIVERSE_TEST_MEDIA_ORIGIN")
            .is_ok_and(|value| value == url.origin().ascii_serialization())
}

#[cfg(not(feature = "isolated-test"))]
fn fixture_source(_url: &Url) -> bool {
    false
}

pub(crate) fn is_active_media_url(url: &Url) -> bool {
    public_media_url(url) && (has_extension(url, "mp4") || has_extension(url, "m3u8"))
}

fn has_extension(url: &Url, expected: &str) -> bool {
    url.path()
        .rsplit_once('.')
        .is_some_and(|(_, value)| value.eq_ignore_ascii_case(expected))
}

fn public_media_url(url: &Url) -> bool {
    url.as_str().len() <= 4096
        && url.query().is_none()
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && (fixture_source(url)
            || (url.scheme() == "https"
                && url.port().is_none()
                && url.host_str().is_some_and(|host| {
                    let host = host.trim_matches(['[', ']']).trim_end_matches('.');
                    host.parse::<IpAddr>()
                        .map(allows_public_address)
                        .unwrap_or_else(|_| {
                            host.contains('.')
                                && !host.ends_with(".localhost")
                                && !host.ends_with(".local")
                        })
                })))
}

async fn public_transport(url: &Url) -> Result<Client, RpcError> {
    let failed = || RpcError::new("network", "Could not reach a public media host.");
    let fixture = fixture_source(url);
    let host = url.host_str().ok_or_else(failed)?.trim_matches(['[', ']']);
    let port = url.port_or_known_default().ok_or_else(failed)?;
    let addresses = timeout(Duration::from_secs(5), lookup_host((host, port)))
        .await
        .map_err(|_| failed())?
        .map_err(|_| failed())?
        .collect::<Vec<_>>();
    if addresses.is_empty()
        || !addresses.iter().all(|address| {
            allows_public_address(address.ip()) || (fixture && address.ip().is_loopback())
        })
    {
        return Err(failed());
    }
    // Connect only to the DNS results already checked. A proxy or redirect could change the destination.
    Client::builder()
        .https_only(!fixture)
        .no_proxy()
        .redirect(Policy::none())
        .resolve_to_addrs(host, &addresses)
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| failed())
}

fn invalid(message: &str) -> RpcError {
    RpcError::new("invalid-input", message)
}
