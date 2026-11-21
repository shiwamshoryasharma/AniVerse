use super::{chrome_process::Pipe, companion::Host, mirror::Ingress, Device, Kind, Media, Status};
use crate::local_player::Grant;
use serde_json::{json, Value};
use std::{
    io,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

pub(super) struct Chrome {
    pipe: Pipe,
    host: Host,
    session: String,
    sinks: Vec<Sink>,
    active: Option<Sink>,
    ready: bool,
}

#[derive(Clone)]
struct Sink {
    id: String,
    name: String,
    route: Option<String>,
}

impl Chrome {
    pub fn open(folder: &Path, cancel: &AtomicBool) -> io::Result<Self> {
        let host = Host::open()?;
        let pipe = Pipe::launch(folder, &host.url)?;
        let mut chrome = Self {
            pipe,
            host,
            session: String::new(),
            sinks: Vec::new(),
            active: None,
            ready: false,
        };
        let started = Instant::now();
        let target = loop {
            let result = chrome.call("Target.getTargets", json!({}), false, 5, cancel)?;
            if let Some(target) = result["targetInfos"]
                .as_array()
                .and_then(|targets| {
                    targets
                        .iter()
                        .find(|target| target["type"] == "page" && target["url"] == chrome.host.url)
                })
                .and_then(|target| id(&target["targetId"], 128))
            {
                break target;
            }
            if started.elapsed() > Duration::from_secs(12) || cancel.load(Ordering::Acquire) {
                return Err(io::Error::other(
                    "Chrome did not open its private casting player.",
                ));
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        let result = chrome.call(
            "Target.attachToTarget",
            json!({"targetId":target,"flatten":true}),
            false,
            5,
            cancel,
        )?;
        chrome.session = id(&result["sessionId"], 128)
            .ok_or_else(|| io::Error::other("Chrome did not attach its casting player."))?;
        chrome.call("Page.enable", json!({}), true, 5, cancel)?;
        chrome.wait_ready(cancel)?;
        chrome.call("Cast.enable", json!({}), true, 6, cancel)?;
        Ok(chrome)
    }

    fn wait_ready(&mut self, cancel: &AtomicBool) -> io::Result<()> {
        let started = Instant::now();
        let deadline = started + Duration::from_secs(8);
        let url = self.host.url.clone();
        let origin = serde_json::to_string(&url).map_err(io::Error::other)?;
        let expression = format!("location.href==={origin} && document.readyState!=='loading' && typeof globalThis.AniVerseChromePlayer?.mirror==='function'");
        let mut retried = false;
        while Instant::now() < deadline {
            let probe_deadline = (Instant::now() + Duration::from_secs(2)).min(deadline);
            match self.call_until(
                "Runtime.evaluate",
                json!({"expression":expression,"returnByValue":true}),
                true,
                probe_deadline,
                cancel,
            ) {
                Ok(response) if response["result"]["value"] == true => {
                    self.ready = true;
                    return Ok(());
                }
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::TimedOut => {}
                Err(error) => return Err(error),
            }
            if !retried && started.elapsed() >= Duration::from_secs(1) && Instant::now() < deadline
            {
                if cancel.load(Ordering::Acquire) {
                    return Err(io::ErrorKind::Interrupted.into());
                }
                // Chromium may defer the navigation response until the new frame commits.
                // The companion's exact origin and API readiness remain the success condition.
                self.pipe
                    .send("Page.navigate", json!({"url":url}), Some(&self.session))?;
                retried = true;
            }
            std::thread::sleep(
                deadline
                    .saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(75)),
            );
        }
        Err(io::Error::other(
            "Chrome did not load its private casting player.",
        ))
    }

    pub fn scan(&mut self, cancel: &AtomicBool) -> io::Result<Vec<Device>> {
        let until = Instant::now() + Duration::from_secs(5);
        while Instant::now() < until {
            self.poll(until, cancel)?;
        }
        Ok(self
            .sinks
            .iter()
            .map(|sink| Device {
                id: format!("chrome:{}", sink.id),
                name: sink.name.clone(),
                model: "Google Chrome · tab casting",
                host: "127.0.0.1",
                port: 0,
                transport: "chrome",
            })
            .collect())
    }

    pub fn start(
        &mut self,
        selected: &str,
        media: Media,
        file: Option<Arc<Grant>>,
        cancel: &AtomicBool,
    ) -> io::Result<Value> {
        let url = file.map_or(media.url, |file| self.host.grant(file));
        let input = json!({"url":url,"title":media.title,"startAt":media.start_at,"live":false,"hls":matches!(media.kind, Kind::Hls),
            "tracks":media.subtitles.into_iter().map(|track| json!({"trackContentId":track.url,
                "name":track.label,"language":track.lang})).collect::<Vec<_>>()});
        self.evaluate("load", Some(&input), 35, cancel)?;
        self.connect(selected, cancel)
    }

    pub fn start_mirror(
        &mut self,
        selected: &str,
        title: &str,
        ingress: Arc<Ingress>,
    ) -> io::Result<Value> {
        let status = self.mirror_preview(title, &ingress)?;
        if super::mirror_fixture(selected) {
            return Ok(status);
        }
        self.connect(selected, ingress.cancellation())
    }

    pub(super) fn mirror_preview(
        &mut self,
        title: &str,
        ingress: &Arc<Ingress>,
    ) -> io::Result<Value> {
        let cancel = ingress.cancellation();
        let url = self.host.mirror(ingress.clone());
        let mut status =
            self.evaluate("mirror", Some(&json!({"url":url,"title":title})), 4, cancel)?;
        let until = Instant::now() + Duration::from_secs(9);
        loop {
            match status["playerState"].as_str() {
                Some("PLAYING") => return Ok(status),
                Some("IDLE") => {
                    let reason = status["mirrorError"]
                        .as_str()
                        .unwrap_or("Website capture stopped.");
                    return Err(io::Error::other(
                        reason.chars().take(140).collect::<String>(),
                    ));
                }
                _ if Instant::now() >= until => {
                    let phase = status["mirrorPhase"].as_str().unwrap_or("starting");
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        format!("Chrome did not render a capture frame ({phase})."),
                    ));
                }
                _ => {}
            }
            std::thread::sleep(Duration::from_millis(80));
            status = self.command("GET_STATUS", None, cancel)?;
        }
    }

    fn connect(&mut self, selected: &str, cancel: &AtomicBool) -> io::Result<Value> {
        let selected = selected.strip_prefix("chrome:").unwrap_or_default();
        let sink = self
            .sinks
            .iter()
            .find(|sink| sink.id == selected)
            .cloned()
            .ok_or_else(|| {
                io::Error::other("That Chrome receiver changed. Find TVs with Chrome again.")
            })?;
        if sink.route.is_some() {
            return Err(io::Error::other(
                "The selected receiver is already casting.",
            ));
        }
        let before: Vec<_> = self
            .sinks
            .iter()
            .filter(|row| row.name == sink.name)
            .cloned()
            .collect();
        let manual = before.len() > 1;
        if manual {
            self.evaluate("manualChoice", None, 5, cancel)?;
            self.call("Page.bringToFront", json!({}), true, 5, cancel)?;
        } else {
            self.call(
                "Cast.startTabMirroring",
                json!({"sinkName":sink.name}),
                true,
                10,
                cancel,
            )?;
        }
        let until = Instant::now() + Duration::from_secs(if manual { 90 } else { 20 });
        while Instant::now() < until {
            let chosen = self.sinks.iter().find(|candidate| {
                candidate.name == sink.name
                    && (manual || candidate.id == sink.id)
                    && candidate.route.as_ref().is_some_and(|route| {
                        before
                            .iter()
                            .find(|row| row.id == candidate.id)
                            .and_then(|row| row.route.as_ref())
                            != Some(route)
                    })
            });
            if let Some(chosen) = chosen {
                self.active = Some(chosen.clone());
                self.evaluate("casting", None, 5, cancel)?;
                return self.command("GET_STATUS", None, cancel);
            }
            self.poll(until, cancel)?;
        }
        Err(io::Error::other(
            "Chrome could not establish a TV session. Check its Cast menu and your TV.",
        ))
    }

    pub fn command(
        &mut self,
        command: &str,
        value: Option<f64>,
        cancel: &AtomicBool,
    ) -> io::Result<Value> {
        self.evaluate("command", Some(&json!([command, value])), 6, cancel)
    }

    pub fn selected_name(&self, id: &str) -> Option<String> {
        let id = id.strip_prefix("chrome:")?;
        self.sinks
            .iter()
            .find(|sink| sink.id == id)
            .map(|sink| sink.name.clone())
    }

    pub fn current(&self) -> Option<(&str, &str)> {
        self.active
            .as_ref()
            .map(|sink| (sink.id.as_str(), sink.name.as_str()))
    }

    pub fn stop(&mut self) {
        if let Some(sink) = self.active.take() {
            if self
                .sinks
                .iter()
                .filter(|candidate| candidate.name == sink.name)
                .count()
                == 1
            {
                let _ = self.call(
                    "Cast.stopCasting",
                    json!({"sinkName":sink.name}),
                    true,
                    2,
                    &AtomicBool::new(false),
                );
            }
        }
        // Closing the one owned tab also ends routes with duplicate display names.
    }

    pub fn fill_status(&self, status: &mut Status, response: &Value) {
        status.status = match response["playerState"].as_str() {
            Some("PLAYING") => "playing",
            Some("PAUSED") => "paused",
            Some("BUFFERING") => "buffering",
            Some("IDLE") if response["idleReason"] == "FINISHED" => "ended",
            _ => "buffering",
        };
        status.current_time = response["currentTime"].as_f64().unwrap_or(0.).max(0.);
        status.duration = response["media"]["duration"]
            .as_f64()
            .unwrap_or(status.duration)
            .max(0.);
        status.volume = response["volume"]["level"]
            .as_f64()
            .unwrap_or(status.volume)
            .clamp(0., 1.);
    }

    fn evaluate(
        &mut self,
        action: &str,
        input: Option<&Value>,
        seconds: u64,
        cancel: &AtomicBool,
    ) -> io::Result<Value> {
        let method = match action {
            "load" => "player.load(arg)",
            "mirror" => "player.mirror(arg)",
            "command" => "player.command(...arg)",
            "manualChoice" => "player.manualChoice()",
            "casting" => "player.casting()",
            _ => return Err(io::ErrorKind::InvalidInput.into()),
        };
        // The expression is fixed. Values are serialized as JavaScript strings
        // and the target must still be the exact private companion page.
        let origin = serde_json::to_string(&self.host.url).map_err(io::Error::other)?;
        let argument = input.unwrap_or(&Value::Null);
        let expression = format!("(() => {{ if(location.href!=={origin}) throw new Error('Invalid casting page'); const player=globalThis.AniVerseChromePlayer; const arg={argument}; return {method}; }})()");
        let response = self.call(
            "Runtime.evaluate",
            json!({"expression":expression,"returnByValue":true,"awaitPromise":true}),
            true,
            seconds,
            cancel,
        )?;
        if let Some(error) = response.get("exceptionDetails") {
            if cfg!(feature = "isolated-test") && action == "mirror" {
                let detail = error["exception"]["description"]
                    .as_str()
                    .and_then(|text| text.lines().next())
                    .unwrap_or("Chrome rejected the capture.")
                    .replace(&self.host.url, "[companion]");
                return Err(io::Error::other(
                    detail.chars().take(160).collect::<String>(),
                ));
            }
            return Err(io::Error::other(
                "Chrome could not decode or control the selected media.",
            ));
        }
        Ok(response["result"]["value"].clone())
    }

    fn call(
        &mut self,
        method: &str,
        params: Value,
        tab: bool,
        seconds: u64,
        cancel: &AtomicBool,
    ) -> io::Result<Value> {
        self.call_until(
            method,
            params,
            tab,
            Instant::now() + Duration::from_secs(seconds),
            cancel,
        )
    }

    fn call_until(
        &mut self,
        method: &str,
        params: Value,
        tab: bool,
        until: Instant,
        cancel: &AtomicBool,
    ) -> io::Result<Value> {
        let expected = self
            .pipe
            .send(method, params, tab.then_some(&self.session))?;
        while Instant::now() < until {
            if let Some(message) = self.poll(until, cancel)? {
                if message["id"] != expected {
                    continue;
                }
                if message.get("error").is_some() {
                    return Err(io::Error::other(format!(
                        "Chrome did not complete {method}."
                    )));
                }
                return Ok(message["result"].clone());
            }
        }
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            format!("Chrome timed out during {method}."),
        ))
    }

    fn poll(&mut self, until: Instant, cancel: &AtomicBool) -> io::Result<Option<Value>> {
        if cancel.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "Chrome casting was cancelled.",
            ));
        }
        let Some(message) = self.pipe.receive(until)? else {
            return Ok(None);
        };
        let params = &message["params"];
        if message["sessionId"] == self.session {
            match message["method"].as_str() {
                Some("Cast.sinksUpdated") => {
                    self.sinks = params["sinks"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .take(100)
                        .filter_map(|sink| {
                            Some(Sink {
                                id: id(&sink["id"], 180)?,
                                name: id(&sink["name"], 200)?,
                                route: id(&sink["session"], 512),
                            })
                        })
                        .collect();
                    if self.active.as_ref().is_some_and(|active| {
                        !self
                            .sinks
                            .iter()
                            .any(|sink| sink.id == active.id && sink.route == active.route)
                    }) {
                        return Err(io::Error::new(
                            io::ErrorKind::ConnectionAborted,
                            "Chrome ended the TV session.",
                        ));
                    }
                }
                Some("Page.frameNavigated")
                    if params["frame"]["parentId"].is_null()
                        && params["frame"]["url"] != self.host.url
                        && (self.ready || params["frame"]["url"] != "about:blank") =>
                {
                    return Err(io::Error::other(
                        "Chrome left its AniVerse companion window.",
                    ));
                }
                _ => {}
            }
        }
        if message["method"] == "Target.detachedFromTarget" && params["sessionId"] == self.session {
            return Err(io::Error::other("The Chrome casting player closed."));
        }
        Ok(Some(message))
    }
}

fn id(value: &Value, limit: usize) -> Option<String> {
    value
        .as_str()
        .filter(|value| {
            !value.is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
        })
        .map(str::to_owned)
}
