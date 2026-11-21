use crate::RpcError;
use regex::Regex;
use serde_json::{json, Value};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use tauri::{
    http::{header, Method, Request, Response, StatusCode},
    Manager, UriSchemeContext, UriSchemeResponder, Webview, Wry,
};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::{oneshot, Semaphore};
use uuid::Uuid;

const ORIGIN: &str = "https://localmedia.localhost";
const APP_ORIGIN: &str = "https://tauri.localhost";
const MAX_READ: u64 = 2 * 1024 * 1024;
const MAX_SUBTITLE: u64 = 2_000_000;
const VIDEO: &[&str] = &["mp4", "m4v", "webm", "mkv", "mov"];

pub(crate) struct Service {
    media: Mutex<Option<Arc<Grant>>>,
    generation: AtomicU64,
    reads: Semaphore,
    dialog: tokio::sync::Mutex<()>,
}

impl Default for Service {
    fn default() -> Self {
        Self {
            media: Mutex::new(None),
            generation: AtomicU64::new(0),
            reads: Semaphore::new(2),
            dialog: Default::default(),
        }
    }
}

pub(crate) struct Grant {
    token: Uuid,
    source: Mutex<File>,
    size: u64,
    mime: &'static str,
}

impl Service {
    pub(crate) async fn open_file(&self, window: &Webview) -> Result<Value, RpcError> {
        let _dialog = self
            .dialog
            .try_lock()
            .map_err(|_| invalid("A file picker is already open."))?;
        let Some(path) = pick(window, "Open video", "Video", VIDEO).await? else {
            return Ok(Value::Null);
        };
        let generation = self.reserve_grant();
        let (grant, name) = tauri::async_runtime::spawn_blocking(move || open_video(path))
            .await
            .map_err(|_| file_error())??;
        self.install_grant(generation, grant, name)
    }

    pub(crate) fn reserve_grant(&self) -> u64 {
        self.generation
            .fetch_add(1, Ordering::AcqRel)
            .wrapping_add(1)
    }

    pub(crate) async fn grant_collection_file(
        &self,
        generation: u64,
        path: PathBuf,
        roots: Vec<PathBuf>,
    ) -> Result<Value, RpcError> {
        let (grant, name) =
            tauri::async_runtime::spawn_blocking(move || open_video_checked(path, Some(&roots)))
                .await
                .map_err(|_| file_error())??;
        self.install_grant(generation, grant, name)
    }

    fn install_grant(
        &self,
        generation: u64,
        grant: Grant,
        name: String,
    ) -> Result<Value, RpcError> {
        let mut media = self.media.lock().unwrap_or_else(|error| error.into_inner());
        if self.generation.load(Ordering::Acquire) != generation {
            return Err(invalid("Another video was selected."));
        }
        let url = format!("{ORIGIN}/{}", grant.token);
        *media = Some(Arc::new(grant));
        Ok(json!({"url": url, "name": name}))
    }

    pub(crate) async fn open_subtitles(&self, window: &Webview) -> Result<Value, RpcError> {
        let _dialog = self
            .dialog
            .try_lock()
            .map_err(|_| invalid("A file picker is already open."))?;
        let Some(path) = pick(
            window,
            "Import subtitles",
            "Subtitle files",
            &["vtt", "srt"],
        )
        .await?
        else {
            return Ok(Value::Null);
        };
        tauri::async_runtime::spawn_blocking(move || read_subtitle(path))
            .await
            .map_err(|_| file_error())?
    }

    pub(crate) fn release(&self, input: Option<&Value>) -> Result<Value, RpcError> {
        let token = input
            .and_then(|input| input["url"].as_str())
            .and_then(|url| url.strip_prefix(ORIGIN))
            .and_then(parse_token)
            .ok_or_else(|| invalid("This is not a local playback grant."))?;
        let mut grant = self.media.lock().unwrap_or_else(|error| error.into_inner());
        if grant.as_ref().is_some_and(|grant| grant.token == token) {
            grant.take();
        }
        Ok(Value::Null)
    }

    // Explicit Cast loads can reuse the already selected open file handle.
    pub(crate) fn cast_grant(&self, url: &str) -> Option<Arc<Grant>> {
        let token = parse_token(url.strip_prefix(ORIGIN)?)?;
        self.media.lock().unwrap_or_else(|error| error.into_inner()).as_ref()
            .filter(|grant| grant.token == token).cloned()
    }

    fn grant_for(&self, request: &Request<Vec<u8>>) -> Option<Arc<Grant>> {
        if request.uri().query().is_some()
            || request
                .headers()
                .get(header::ORIGIN)
                .is_some_and(|origin| origin.as_bytes() != APP_ORIGIN.as_bytes())
        {
            return None;
        }
        let token = parse_token(request.uri().path())?;
        self.media
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .filter(|grant| grant.token == token)
            .cloned()
    }
}

pub(crate) fn respond(
    context: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    if context.webview_label() != "main" {
        return responder.respond(empty(StatusCode::NOT_FOUND));
    }
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        return responder.respond(empty(StatusCode::METHOD_NOT_ALLOWED));
    }
    let app = context.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let Some(service) = app.try_state::<Service>() else {
            return responder.respond(empty(StatusCode::NOT_FOUND));
        };
        let Some(grant) = service.grant_for(&request) else {
            return responder.respond(empty(StatusCode::NOT_FOUND));
        };
        let Ok(_read) = service.reads.try_acquire() else {
            return responder.respond(empty(StatusCode::SERVICE_UNAVAILABLE));
        };
        let response = tauri::async_runtime::spawn_blocking(move || grant.read(&request))
            .await
            .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR));
        responder.respond(response);
    });
}

impl Grant {
    pub(crate) fn size(&self) -> u64 { self.size }

    pub(crate) fn mime(&self) -> &'static str { self.mime }

    pub(crate) fn read_at(&self, start: u64, body: &mut [u8]) -> std::io::Result<()> {
        let mut source = self.source.lock().unwrap_or_else(|error| error.into_inner());
        source.seek(SeekFrom::Start(start))?;
        source.read_exact(body)
    }


    fn read(&self, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        let headers = request.headers();
        let head = request.method() == Method::HEAD;
        let range = if head {
            None
        } else {
            headers.get(header::RANGE)
        };
        let (start, length, status) = match range {
            Some(value) => {
                let Some((start, end)) = value
                    .to_str()
                    .ok()
                    .and_then(|value| byte_range(value, self.size))
                else {
                    return Response::builder()
                        .status(StatusCode::RANGE_NOT_SATISFIABLE)
                        .header(header::CONTENT_RANGE, format!("bytes */{}", self.size))
                        .body(vec![])
                        .unwrap();
                };
                (
                    start,
                    (end - start + 1).min(MAX_READ),
                    StatusCode::PARTIAL_CONTENT,
                )
            }
            None if head || self.size <= MAX_READ => (0, self.size, StatusCode::OK),
            None => return empty(StatusCode::PAYLOAD_TOO_LARGE),
        };
        let mut body = vec![0; if head { 0 } else { length as usize }];
        if !head {
            let mut source = self
                .source
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if source
                .seek(SeekFrom::Start(start))
                .and_then(|_| source.read_exact(&mut body))
                .is_err()
            {
                return empty(StatusCode::NOT_FOUND);
            }
        }
        let mut builder = Response::builder()
            .status(status)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CONTENT_TYPE, self.mime)
            .header(header::CONTENT_LENGTH, length)
            .header(header::CACHE_CONTROL, "no-store")
            .header("x-content-type-options", "nosniff")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, APP_ORIGIN);
        if status == StatusCode::PARTIAL_CONTENT {
            builder = builder.header(
                header::CONTENT_RANGE,
                format!("bytes {start}-{}/{}", start + length - 1, self.size),
            );
        }
        builder.body(body).unwrap()
    }
}

fn parse_token(path: &str) -> Option<Uuid> {
    let token = path.strip_prefix('/')?;
    let id = Uuid::parse_str(token).ok()?;
    (token == id.to_string()).then_some(id)
}

pub(crate) fn byte_range(value: &str, size: u64) -> Option<(u64, u64)> {
    let last = size.checked_sub(1)?;
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    let number = |part: &str| {
        part.parse::<u64>()
            .ok()
            .filter(|_| part.bytes().all(|byte| byte.is_ascii_digit()))
    };
    if start.is_empty() {
        let tail = number(end)?;
        return (tail != 0).then_some((size.saturating_sub(tail), last));
    }
    let first = number(start)?;
    let last = if end.is_empty() {
        last
    } else {
        number(end)?.min(last)
    };
    (first <= last).then_some((first, last))
}

async fn pick(
    window: &Webview,
    title: &str,
    label: &str,
    extensions: &[&str],
) -> Result<Option<PathBuf>, RpcError> {
    let (send, receive) = oneshot::channel();
    window
        .dialog()
        .file()
        .set_parent(&window.window())
        .set_title(title)
        .add_filter(label, extensions)
        .pick_file(move |path| {
            let _ = send.send(path);
        });
    receive
        .await
        .map_err(|_| file_error())?
        .map(|file| file.into_path().map_err(|_| file_error()))
        .transpose()
}

fn open_video(path: PathBuf) -> Result<(Grant, String), RpcError> {
    open_video_checked(path, None)
}

fn open_video_checked(
    path: PathBuf,
    roots: Option<&[PathBuf]>,
) -> Result<(Grant, String), RpcError> {
    let actual = path.canonicalize().map_err(|_| file_error())?;
    if roots.is_some_and(|roots| !collection_contains(roots, &actual)) {
        return Err(file_error());
    }
    let extension = actual
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        _ => return Err(invalid("Choose an MP4, M4V, WebM, MKV, or MOV video.")),
    };
    let source = File::open(actual).map_err(|_| file_error())?;
    if let Some(roots) = roots {
        let resolved = opened_path(&source).ok_or_else(file_error)?;
        if !collection_contains(roots, &resolved) {
            return Err(file_error());
        }
    }
    let metadata = source.metadata().map_err(|_| file_error())?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(invalid("Choose a nonempty video file."));
    }
    Ok((
        Grant {
            token: Uuid::new_v4(),
            source: Mutex::new(source),
            size: metadata.len(),
            mime,
        },
        basename(&path),
    ))
}

fn collection_contains(roots: &[PathBuf], file: &Path) -> bool {
    roots
        .iter()
        .any(|root| file != root && file.starts_with(root))
}

#[cfg(windows)]
fn opened_path(file: &File) -> Option<PathBuf> {
    use std::os::windows::{
        ffi::OsStringExt,
        io::{AsRawHandle, RawHandle},
    };

    #[link(name = "kernel32")]
    extern "system" {
        fn GetFinalPathNameByHandleW(
            handle: RawHandle,
            path: *mut u16,
            len: u32,
            flags: u32,
        ) -> u32;
    }

    let mut path = vec![0u16; 32_768];
    // The verified path comes from the same open file handle the media grant will keep.
    let size = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            path.as_mut_ptr(),
            path.len() as u32,
            0,
        )
    } as usize;
    (size > 0 && size < path.len())
        .then(|| PathBuf::from(std::ffi::OsString::from_wide(&path[..size])))
}

#[cfg(not(windows))]
fn opened_path(_: &File) -> Option<PathBuf> {
    None
}

fn read_subtitle(path: PathBuf) -> Result<Value, RpcError> {
    let actual = path.canonicalize().map_err(|_| file_error())?;
    if !actual
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("vtt") || extension.eq_ignore_ascii_case("srt")
        })
    {
        return Err(invalid("Choose a UTF-8 WebVTT or SRT subtitle file."));
    }
    let file = File::open(actual).map_err(|_| file_error())?;
    let metadata = file.metadata().map_err(|_| file_error())?;
    if !metadata.is_file() || metadata.len() > MAX_SUBTITLE {
        return Err(invalid("Subtitle files must be smaller than 2 MB."));
    }
    let mut text = String::new();
    file.take(MAX_SUBTITLE + 1)
        .read_to_string(&mut text)
        .map_err(|_| invalid("Choose a UTF-8 WebVTT or SRT subtitle file."))?;
    Ok(json!({"name": basename(&path), "text": subtitle_vtt(&text)?}))
}

fn subtitle_vtt(text: &str) -> Result<String, RpcError> {
    static CUE: OnceLock<Regex> = OnceLock::new();
    static SRT: OnceLock<Regex> = OnceLock::new();
    let timestamps = CUE.get_or_init(|| Regex::new(r"[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?[.,][0-9]{3}\s+-->\s+[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?[.,][0-9]{3}").unwrap());
    if text.len() as u64 > MAX_SUBTITLE || text.contains('\0') || !timestamps.is_match(text) {
        return Err(invalid(
            "Choose a valid UTF-8 WebVTT or SRT subtitle file smaller than 2 MB.",
        ));
    }
    let normalized = text
        .strip_prefix('\u{feff}')
        .unwrap_or(text)
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let normalized = normalized.trim();
    if normalized.split_whitespace().next() == Some("WEBVTT") {
        return Ok(format!("{normalized}\n"));
    }
    let separator =
        SRT.get_or_init(|| Regex::new(r"([0-9]{2}:[0-9]{2}:[0-9]{2}),([0-9]{3})").unwrap());
    Ok(format!(
        "WEBVTT\n\n{}\n",
        separator.replace_all(normalized, "${1}.${2}")
    ))
}

fn basename(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .body(vec![])
        .unwrap()
}

fn file_error() -> RpcError {
    RpcError::new("config", "Could not open the selected local file.")
}

fn invalid(message: &str) -> RpcError {
    RpcError::new("invalid-input", message)
}

#[cfg(test)]
#[path = "../../../test/tauri-compat/local-player.rs"]
mod tests;
