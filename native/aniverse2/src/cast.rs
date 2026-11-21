mod chrome;
mod chrome_process;
mod companion;
mod discovery;
pub(crate) mod mirror;
#[cfg(test)]
mod wire;

use crate::{
    local_player::{self, Grant},
    player, RpcError,
};
use chrome::Chrome;
use mirror::Ingress;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Url, Webview};
use tokio::sync::oneshot;
use uuid::Uuid;

#[derive(Serialize)]
struct Device {
    transport: &'static str,
    id: String,
    name: String,
    model: &'static str,
    host: &'static str,
    port: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Start {
    device_id: String,
    media: Media,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Media {
    url: String,
    title: String,

    kind: Kind,
    subtitle: Option<String>,
    image: Option<String>,
    #[serde(default)]
    start_at: f64,
    #[serde(default)]
    subtitles: Vec<Track>,
    #[serde(default)]
    upscale4k: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Hls,
    Dash,
    Mp4,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Track {
    label: String,
    lang: String,
    url: String,
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    transport: Option<&'static str>,
    device: Option<DeviceName>,
    status: &'static str,
    current_time: f64,
    duration: f64,
    title: Option<String>,
    volume: f64,
    error: Option<String>,
}

#[derive(Clone, PartialEq, Serialize)]
struct DeviceName {
    id: String,
    name: String,
}

impl Default for Status {
    fn default() -> Self {
        Self {
            transport: None,
            device: None,
            status: "idle",
            current_time: 0.,
            duration: 0.,
            title: None,
            volume: 1.,
            error: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MirrorStart {
    web_contents_id: u64,
    device_id: String,
    title: String,
    upscale: bool,
}

enum Playback {
    Direct(Media, Option<Arc<Grant>>),
    Mirror(String, Arc<Ingress>),
}

enum Operation {
    Scan,
    CloseIdle,
    CheckMirror(String),
    Start(String, Playback),
    Control(&'static str, Option<f64>),
    Stop,
}

type Reply = Result<Value, RpcError>;

pub(crate) struct Service {
    worker: mpsc::SyncSender<(Operation, oneshot::Sender<Reply>)>,
    mirror: Mutex<Option<Arc<Ingress>>>,
    status: Arc<Mutex<Status>>,
    cancelled: Arc<AtomicBool>,
}

struct Worker {
    app: AppHandle,
    folder: PathBuf,
    chrome: Option<Chrome>,
    current_mirror: Option<Arc<Ingress>>,
    status: Arc<Mutex<Status>>,
    cancelled: Arc<AtomicBool>,
    idle_expires: Instant,
}

impl Service {
    pub(crate) fn new(app: AppHandle, folder: PathBuf) -> std::io::Result<Self> {
        let (worker, rx) = mpsc::sync_channel(8);
        let status = Arc::new(Mutex::new(Status::default()));
        let cancelled = Arc::new(AtomicBool::new(false));
        let handler = Worker {
            app,
            folder,
            chrome: None,
            current_mirror: None,
            status: status.clone(),
            cancelled: cancelled.clone(),
            idle_expires: Instant::now(),
        };
        std::thread::Builder::new()
            .name("aniverse-casting".into())
            .spawn(move || handler.run(rx))?;
        Ok(Self {
            worker,
            mirror: Mutex::new(None),
            status,
            cancelled,
        })
    }

    pub(crate) async fn request(
        &self,
        method: &str,
        input: Value,
        local: &local_player::Service,
        owner: &Webview,
        player: &player::Service,
    ) -> Reply {
        let operation = match method {
            "cast.capabilities" => {
                return Ok(json!({"available":false,"version":null,
                "message":"Embedded 4K sender processing is unavailable in this Windows build."}))
            }
            "cast.state" => {
                return Ok(json!(*self
                    .status
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())))
            }
            "cast.devices" => return discovery::scan().await,
            "cast.windowsDisplay" => return windows_display(input).await,
            "cast.chromeDevices" => Operation::Scan,
            "cast.chromeClose" => Operation::CloseIdle,
            "cast.mirrorPrepare" => return self.prepare_mirror(owner, player, input).await,
            "cast.mirrorChunk" => return self.acknowledge(&input),
            "cast.mirrorStop" => {
                self.stop_mirror(mirror_ticket(&input)?)?;
                return Ok(Value::Null);
            }
            "cast.start" => {
                let request: Start = serde_json::from_value(input).map_err(|_| invalid())?;
                if !request.device_id.starts_with("chrome:") {
                    return Err(RpcError::new(
                        "unavailable",
                        "Choose a receiver with Find TVs with Chrome.",
                    ));
                }
                let file = local.cast_grant(&request.media.url);
                request.validate(file.is_some())?;
                if self
                    .mirror
                    .lock()
                    .map_err(|_| busy())?
                    .as_ref()
                    .is_some_and(|item| !item.is_closed())
                {
                    return Err(busy());
                }
                Operation::Start(request.device_id, Playback::Direct(request.media, file))
            }
            "cast.control" => {
                let action = match input["action"].as_str() {
                    Some("play") => "PLAY",
                    Some("pause") => "PAUSE",
                    Some("seek") => "SEEK",
                    Some("volume") => "VOLUME",
                    _ => return Err(invalid()),
                };
                let value = input["value"].as_f64();
                if matches!(action, "SEEK" | "VOLUME")
                    && !value.is_some_and(|value| {
                        value.is_finite()
                            && (0.0..=if action == "SEEK" { 604800.0 } else { 1.0 })
                                .contains(&value)
                    })
                {
                    return Err(invalid());
                }
                Operation::Control(action, value)
            }
            "cast.stop" => {
                if let Some(item) = self.mirror.lock().map_err(|_| busy())?.as_ref() {
                    item.close();
                }
                self.cancelled.store(true, Ordering::Release);
                Operation::Stop
            }
            _ => return Err(invalid()),
        };
        Self::finish(self.enqueue(operation)?).await
    }

    async fn prepare_mirror(
        &self,
        owner: &Webview,
        player: &player::Service,
        input: Value,
    ) -> Reply {
        let request: MirrorStart = serde_json::from_value(input).map_err(|_| invalid())?;
        if request.web_contents_id == 0
            || !request.device_id.starts_with("chrome:")
            || request.device_id.len() > 200
            || request.title.trim().is_empty()
            || !text(&request.title, 300)
        {
            return Err(invalid());
        }
        if request.upscale {
            return Err(RpcError::new(
                "unavailable",
                "Windows website mirroring supports video only and no sender-side 4K processing.",
            ));
        }
        Self::finish(self.enqueue(Operation::CheckMirror(request.device_id.clone()))?).await?;
        let ingress = Arc::new(Ingress::new());
        {
            let mut current = self.mirror.lock().map_err(|_| busy())?;
            if current.as_ref().is_some_and(|item| !item.is_closed()) {
                return Err(busy());
            }
            *current = Some(ingress.clone());
        }
        if let Err(error) = player
            .prepare_mirror(owner, request.web_contents_id, ingress.clone())
            .await
        {
            ingress.close();
            return Err(error);
        }
        if ingress.is_closed() {
            return Err(invalid());
        }
        let route = Operation::Start(
            request.device_id,
            Playback::Mirror(request.title, ingress.clone()),
        );
        let result = match self.enqueue(route) {
            Ok(result) => result,
            Err(error) => {
                ingress.close();
                return Err(error);
            }
        };
        let ticket = ingress.ticket();
        tauri::async_runtime::spawn(async move {
            if Self::finish(result).await.is_err() {
                ingress.close();
            }
        });
        Ok(json!({"ticket":ticket}))
    }

    fn acknowledge(&self, input: &Value) -> Reply {
        let ticket = mirror_ticket(input)?;
        let sequence = input["sequence"].as_u64().ok_or_else(invalid)?;
        let bytes = &input["bytes"];
        if !bytes.as_array().is_some_and(Vec::is_empty)
            && !bytes.as_object().is_some_and(serde_json::Map::is_empty)
        {
            return Err(invalid());
        }
        let mirror = self.mirror.lock().map_err(|_| busy())?;
        if mirror
            .as_ref()
            .is_some_and(|item| item.ticket() == ticket && item.acknowledge(sequence))
        {
            return Ok(Value::Null);
        }
        Err(invalid())
    }

    fn stop_mirror(&self, ticket: Uuid) -> Result<(), RpcError> {
        let mut mirror = self.mirror.lock().map_err(|_| busy())?;
        if mirror.as_ref().is_some_and(|item| item.ticket() == ticket) {
            if let Some(item) = mirror.take() {
                item.close();
            }
        }
        Ok(())
    }

    fn enqueue(&self, operation: Operation) -> Result<oneshot::Receiver<Reply>, RpcError> {
        let (reply, result) = oneshot::channel();
        self.worker
            .try_send((operation, reply))
            .map_err(|_| busy())?;
        Ok(result)
    }

    async fn finish(result: oneshot::Receiver<Reply>) -> Reply {
        result
            .await
            .map_err(|_| RpcError::new("unavailable", "The Windows casting service closed."))?
    }
}

fn mirror_fixture(device: &str) -> bool {
    cfg!(feature = "isolated-test")
        && device == "chrome:isolated-mirror-fixture"
        && std::env::var_os("ANIVERSE2_MIRROR_FIXTURE").is_some_and(|enabled| enabled == "1")
}

fn mirror_ticket(input: &Value) -> Result<Uuid, RpcError> {
    input["ticket"]
        .as_str()
        .and_then(|ticket| Uuid::parse_str(ticket).ok())
        .ok_or_else(invalid)
}

fn busy() -> RpcError {
    RpcError::new("unavailable", "The Windows casting service is busy.")
}

pub(crate) fn handles(method: &str) -> bool {
    matches!(
        method,
        "cast.capabilities"
            | "cast.devices"
            | "cast.chromeDevices"
            | "cast.chromeClose"
            | "cast.mirrorPrepare"
            | "cast.mirrorChunk"
            | "cast.mirrorStop"
            | "cast.start"
            | "cast.control"
            | "cast.stop"
            | "cast.state"
            | "cast.windowsDisplay"
    )
}

impl Worker {
    fn run(mut self, commands: mpsc::Receiver<(Operation, oneshot::Sender<Reply>)>) {
        loop {
            let command = if self.chrome.is_some() {
                commands.recv_timeout(Duration::from_millis(800))
            } else {
                commands
                    .recv()
                    .map_err(|_| mpsc::RecvTimeoutError::Disconnected)
            };
            match command {
                Ok((command, reply)) => {
                    let result = self.execute(command);
                    let _ = reply.send(result);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => self.tick(),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        self.stop();
    }

    fn execute(&mut self, command: Operation) -> Reply {
        match command {
            Operation::Scan => {
                if self
                    .chrome
                    .as_ref()
                    .is_some_and(|chrome| chrome.current().is_some())
                {
                    return Err(RpcError::new(
                        "unavailable",
                        "Stop the current cast before scanning.",
                    ));
                }
                self.cancelled.store(false, Ordering::Release);
                let result = (|| -> std::io::Result<Vec<Device>> {
                    if self.chrome.is_none() {
                        self.chrome = Some(Chrome::open(&self.folder, &self.cancelled)?);
                    }
                    self.chrome.as_mut().unwrap().scan(&self.cancelled)
                })();
                self.idle_expires = Instant::now() + Duration::from_secs(120);
                match result {
                    Ok(devices) => Ok(json!(devices)),
                    Err(error) => {
                        self.chrome.take();
                        Err(cast_error(error))
                    }
                }
            }
            Operation::CheckMirror(device) => {
                if mirror_fixture(&device) && self.chrome.is_none() {
                    self.cancelled.store(false, Ordering::Release);
                    self.chrome =
                        Some(Chrome::open(&self.folder, &self.cancelled).map_err(cast_error)?);
                }
                let chrome = self.chrome.as_ref().ok_or_else(no_cast)?;
                if self.current_mirror.is_some()
                    || chrome.current().is_some()
                    || (!mirror_fixture(&device) && chrome.selected_name(&device).is_none())
                {
                    return Err(no_cast());
                }
                self.idle_expires = Instant::now() + Duration::from_secs(15);
                Ok(Value::Null)
            }
            Operation::Start(device_id, playback) => {
                let mut chrome = self.chrome.take().ok_or_else(no_cast)?;
                if self.current_mirror.is_some() || chrome.current().is_some() {
                    self.chrome = Some(chrome);
                    return Err(RpcError::new(
                        "unavailable",
                        "Stop the current cast before choosing another TV.",
                    ));
                }
                let selected =
                    if matches!(&playback, Playback::Mirror(..)) && mirror_fixture(&device_id) {
                        Some("Isolated Chrome capture fixture".to_owned())
                    } else {
                        chrome.selected_name(&device_id)
                    };
                let Some(device) = selected else {
                    self.chrome = Some(chrome);
                    return Err(no_cast());
                };
                let (title, current_time, volume) = match &playback {
                    Playback::Direct(media, _) => (media.title.clone(), media.start_at, 1.0),
                    Playback::Mirror(title, ingress) if !ingress.is_closed() => {
                        (title.clone(), 0.0, 0.0)
                    }
                    Playback::Mirror(_, _) => {
                        self.chrome = Some(chrome);
                        return Err(no_cast());
                    }
                };
                self.cancelled.store(false, Ordering::Release);
                let generation = Status {
                    transport: Some("chrome"),
                    device: Some(DeviceName {
                        id: device_id.clone(),
                        name: device,
                    }),
                    status: "connecting",
                    current_time,
                    title: Some(title),
                    volume,
                    ..Status::default()
                };
                self.publish(generation);
                let result = match playback {
                    Playback::Direct(media, file) => {
                        chrome.start(&device_id, media, file, &self.cancelled)
                    }
                    Playback::Mirror(title, ingress) => {
                        let result = chrome.start_mirror(&device_id, &title, ingress.clone());
                        if result.is_err() {
                            ingress.close();
                        } else {
                            self.current_mirror = Some(ingress);
                        }
                        result
                    }
                };
                match result {
                    Ok(response) => {
                        self.chrome = Some(chrome);
                        Ok(self.playback(&response))
                    }
                    Err(error) => {
                        chrome.stop();
                        if error.kind() == std::io::ErrorKind::Interrupted {
                            self.publish(Status::default());
                        } else {
                            self.publish(Status {
                                status: "error",
                                error: Some(error.to_string()),
                                ..Status::default()
                            });
                        }
                        Err(cast_error(error))
                    }
                }
            }
            Operation::Control(command, value) => {
                if self.current_mirror.is_some() {
                    return Err(RpcError::new(
                        "unavailable",
                        "Control mirrored video in its website player.",
                    ));
                }
                let chrome = self
                    .chrome
                    .as_mut()
                    .filter(|chrome| chrome.current().is_some())
                    .ok_or_else(no_cast)?;
                let response = chrome
                    .command(command, value, &self.cancelled)
                    .map_err(cast_error)?;
                Ok(self.playback(&response))
            }
            Operation::Stop => {
                self.stop();
                Ok(json!(self.snapshot()))
            }
            Operation::CloseIdle => {
                if self
                    .chrome
                    .as_ref()
                    .is_some_and(|chrome| chrome.current().is_none())
                {
                    self.chrome.take();
                }
                Ok(Value::Null)
            }
        }
    }

    fn tick(&mut self) {
        if self
            .current_mirror
            .as_ref()
            .is_some_and(|mirror| mirror.is_closed() || mirror.expired())
        {
            self.stop();
            return;
        }
        let Some(chrome) = self.chrome.as_mut() else {
            return;
        };
        if chrome.current().is_none() && self.current_mirror.is_none() {
            if Instant::now() >= self.idle_expires {
                self.chrome.take();
            }
            return;
        }
        let cancellation = self
            .current_mirror
            .as_ref()
            .map_or(self.cancelled.as_ref(), |mirror| mirror.cancellation());
        match chrome.command("GET_STATUS", None, cancellation) {
            Ok(response) => {
                self.playback(&response);
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                if self
                    .current_mirror
                    .as_ref()
                    .is_some_and(|mirror| mirror.is_closed())
                {
                    self.stop();
                }
            }
            Err(error) => {
                if let Some(item) = self.current_mirror.take() {
                    item.close();
                }
                let status = if error.kind() == std::io::ErrorKind::ConnectionAborted {
                    Status {
                        status: "ended",
                        ..self.snapshot()
                    }
                } else {
                    Status {
                        status: "error",
                        error: Some(error.to_string()),
                        ..Status::default()
                    }
                };
                self.publish(status);
                self.chrome.take();
            }
        }
    }

    fn playback(&mut self, response: &Value) -> Value {
        let mut status = self.snapshot();
        if let Some(chrome) = self.chrome.as_ref() {
            chrome.fill_status(&mut status, response);
            if let Some((id, name)) = chrome.current() {
                status.device = Some(DeviceName {
                    id: format!("chrome:{id}"),
                    name: name.to_owned(),
                });
            }
        }
        let ended = status.status == "ended";
        if ended {
            if let Some(item) = self.current_mirror.take() {
                item.close();
            }
        }
        let output = json!(&status);
        self.publish(status);
        if ended {
            if let Some(mut chrome) = self.chrome.take() {
                chrome.stop();
            }
        }
        output
    }

    fn stop(&mut self) {
        if let Some(item) = self.current_mirror.take() {
            item.close();
        }
        self.publish(Status::default());
        if let Some(mut chrome) = self.chrome.take() {
            chrome.stop();
        }
    }

    fn snapshot(&self) -> Status {
        self.status
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn publish(&self, next: Status) {
        let mut status = self
            .status
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if *status != next {
            *status = next;
            let _ = self.app.emit("aniverse:cast/status", &*status);
        }
    }
}

impl Start {
    fn validate(&self, file: bool) -> Result<(), RpcError> {
        let media = &self.media;
        if media.upscale4k {
            return Err(RpcError::new(
                "unavailable",
                "Sender-side 4K processing is unavailable.",
            ));
        }
        if self.device_id.len() > 200
            || !text(&media.title, 300)
            || media
                .subtitle
                .as_ref()
                .is_some_and(|subtitle| !text(subtitle, 300))
            || media.image.as_ref().is_some_and(|image| !remote_url(image))
            || !media.start_at.is_finite()
            || !(0.0..=86400.0).contains(&media.start_at)
            || (!file && !remote_url(&media.url))
            || media.subtitles.len() > 10
            || media.subtitles.iter().any(|track| {
                !text(&track.label, 80) || !text(&track.lang, 20) || !remote_url(&track.url)
            })
        {
            return Err(invalid());
        }
        Ok(())
    }
}

fn text(value: &str, length: usize) -> bool {
    value.len() <= length && !value.chars().any(char::is_control)
}

fn remote_url(value: &str) -> bool {
    value.len() <= 4000
        && text(value, 4000)
        && Url::parse(value).is_ok_and(|url| {
            matches!(url.scheme(), "https" | "http")
                && url.username().is_empty()
                && url.password().is_none()
                && url.host().is_some()
        })
}

async fn windows_display(input: Value) -> Reply {
    let (target, path) = match input["target"].as_str() {
        Some("connect") => ("connect", "ms-settings-connectabledevices:devicediscovery"),
        Some("display") => ("display", "ms-settings:display"),
        Some("sound") => ("sound", "ms-settings:sound"),
        _ => return Err(invalid()),
    };
    if cfg!(feature = "isolated-test") {
        return Err(RpcError::new(
            "unavailable",
            "Windows display controls are disabled in isolated tests.",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let launch = |uri| crate::sources::open_in_windows(std::ffi::OsStr::new(uri));
        match launch(path) {
            Ok(()) => Ok(json!({"opened":target,"fallback":false})),
            Err(_) if target == "connect" => {
                launch("ms-settings:display").map_err(cast_error)?;
                Ok(json!({"opened":"display","fallback":true}))
            }
            Err(error) => Err(cast_error(error)),
        }
    })
    .await
    .map_err(|_| RpcError::new("unavailable", "Could not open Windows display settings."))?
}

fn invalid() -> RpcError {
    RpcError::new("invalid-input", "The Cast request is invalid.")
}
fn no_cast() -> RpcError {
    RpcError::new(
        "unavailable",
        "Find TVs with Chrome before starting a cast.",
    )
}
fn cast_error(error: std::io::Error) -> RpcError {
    RpcError::new("network", error.to_string())
}

#[cfg(test)]
#[path = "../../../test/tauri-compat/cast-chrome.rs"]
mod tests;
