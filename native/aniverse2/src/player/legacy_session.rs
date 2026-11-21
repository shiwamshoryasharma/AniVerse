use super::Source;
#[cfg(feature = "installer-handoff")]
use crate::integrations;
use crate::RpcError;
use serde::Deserialize;
use std::{
    fs::{self, File, OpenOptions},
    io,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, Webview};
use webview2_com::{take_pwstr, GetCookiesCompletedHandler, Microsoft::Web::WebView2::Win32::*};
use windows::core::{w, Interface, HSTRING, PWSTR};

const ARCHIVE: &str = "website-sessions.json";
const CONSUMED: &str = "website-sessions-processed";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Packet {
    schema: u32,
    nonce: uuid::Uuid,
    source: String,
    origin: String,
    cookies: Vec<Cookie>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cookie {
    name: String,
    value: String,
    path: String,
    http_only: bool,
    expires: f64,
    same_site: SameSite,
}

#[derive(Deserialize)]
enum SameSite {
    Lax,
    Strict,
    None,
}

impl Cookie {
    fn supported(&self) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();
        (now..now + 400. * 86400.).contains(&self.expires)
            && (1..=256).contains(&self.name.len())
            && self
                .name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_\x60|~".contains(&b))
            && self.value.len() <= 4096
            && self
                .value
                .bytes()
                .all(|b| matches!(b, 0x21 | 0x23..=0x2b | 0x2d..=0x3a | 0x3c..=0x5b | 0x5d..=0x7e))
            && (!self.name.starts_with("__Host-") || self.path == "/")
            && self.path.starts_with('/')
            && self.path.len() <= 1024
            && self
                .path
                .bytes()
                .all(|b| matches!(b, 0x20..=0x3a | 0x3c..=0x7e))
    }
}

impl Drop for Cookie {
    fn drop(&mut self) {
        unsafe {
            self.value.as_bytes_mut().fill(0);
        }
    }
}

fn pending_claim(root: &Path, source: &Source) -> io::Result<Option<File>> {
    if !possible(root)?
        || source.kind != "web"
        || source.base.scheme() != "https"
        || source.base.port().is_some()
        || source.id.len() > 128
        || source.id.is_empty()
        || !source
            .id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Ok(None);
    }
    let claims = root.join(CONSUMED);
    fs::create_dir_all(&claims)?;
    let gate = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(claims.join(format!("{}.lock", source.id)))?;
    gate.try_lock()?;
    match File::create_new(claims.join(&source.id)) {
        Ok(marker) => {
            marker.sync_all()?;
            Ok(Some(gate))
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(None),
        Err(error) => Err(error),
    }
}

fn possible(root: &Path) -> io::Result<bool> {
    if !cfg!(feature = "installer-handoff")
        || root.file_name().and_then(|name| name.to_str()) != Some("profile-data")
    {
        return Ok(false);
    }
    root.join(ARCHIVE).try_exists()
}

pub(super) fn forget(root: &Path, source: &Source) -> Result<(), RpcError> {
    pending_claim(root, source).map(|_| ()).map_err(|_| {
        super::failure("The source session transfer is still in progress. Try again shortly.")
    })
}

pub(super) async fn restore(view: &Webview, source: &Source, directory: &Path) {
    let root = view.state::<std::path::PathBuf>();
    if crate::runtime_privacy::active()
        || directory
            .parent()
            .and_then(Path::parent)
            .is_none_or(|home| home.join("profile-data") != root.as_path())
    {
        return;
    }
    let epoch = crate::runtime_privacy::epoch();
    let Some(packet) = read_packet(&root, source) else {
        return;
    };
    let Ok(Some(claim)) = pending_claim(&root, source) else {
        return;
    };
    let Some(host) = source.base.host_str().map(str::to_owned) else {
        return;
    };
    let Ok(directory) = directory.canonicalize() else {
        return;
    };
    let (send, received) = tokio::sync::oneshot::channel();
    if view
        .with_webview(move |platform| {
            let _ = (|| unsafe {
                let mut actual = PWSTR::null();
                platform
                    .environment()
                    .cast::<ICoreWebView2Environment7>()?
                    .UserDataFolder(&mut actual)?;
                let same = Path::new(&take_pwstr(actual)).canonicalize().ok() == Some(directory);
                if !same {
                    return Ok::<_, windows::core::Error>(());
                }
                let manager = platform
                    .controller()
                    .CoreWebView2()?
                    .cast::<ICoreWebView2_2>()?
                    .CookieManager()?;
                let jar = manager.clone();
                let handler = GetCookiesCompletedHandler::create(Box::new(move |status, list| {
                    // Move the claim into the callback so clearing can never race a late response.
                    let _claim = claim;
                    status?;
                    let mut count = 1;
                    if let Some(list) = list {
                        list.Count(&mut count)?;
                    }
                    if count == 0 {
                        for cookie in packet.cookies {
                            if crate::runtime_privacy::active()
                                || crate::runtime_privacy::epoch() != epoch
                            {
                                break;
                            }
                            let _ = save(&jar, &host, &cookie);
                        }
                    }
                    let _ = send.send(());
                    Ok(())
                }));
                manager.GetCookies(w!(""), &handler)
            })();
        })
        .is_ok()
    {
        let _ = tokio::time::timeout(Duration::from_secs(5), received).await;
    }
}

#[cfg(not(feature = "installer-handoff"))]
fn read_packet(_: &Path, _: &Source) -> Option<Packet> {
    None
}

#[cfg(feature = "installer-handoff")]
fn read_packet(root: &Path, source: &Source) -> Option<Packet> {
    let (nonce, archive) =
        aniverse_desktop_migration::ProfileProof::verified_website_sessions(root).ok()??;
    let entries: std::collections::BTreeMap<String, String> =
        serde_json::from_slice(&archive).ok()?;
    let value = entries.get(&source.id)?;
    if !value.starts_with("enc2:") {
        return None;
    }
    let mut secret = integrations::open_migrated_secret(root, value).ok()?;
    let packet: Result<Packet, _> = serde_json::from_str(&secret);
    unsafe {
        secret.as_bytes_mut().fill(0);
    }
    let packet = packet.ok()?;
    if packet.schema == 1
        && packet.nonce == nonce
        && packet.source == source.id
        && packet.origin == source.base.origin().ascii_serialization()
        && packet.cookies.len() <= 64
        && packet.cookies.iter().all(Cookie::supported)
    {
        Some(packet)
    } else {
        None
    }
}

unsafe fn save(
    manager: &ICoreWebView2CookieManager,
    host: &str,
    cookie: &Cookie,
) -> windows::core::Result<()> {
    let value = manager.CreateCookie(
        &HSTRING::from(cookie.name.as_str()),
        &HSTRING::from(cookie.value.as_str()),
        &HSTRING::from(host),
        &HSTRING::from(cookie.path.as_str()),
    )?;
    let policy = match cookie.same_site {
        SameSite::Strict => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT,
        SameSite::Lax => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX,
        SameSite::None => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE,
    };
    value.SetExpires(cookie.expires)?;
    value.SetIsSecure(true)?;
    value.SetIsHttpOnly(cookie.http_only)?;
    value.SetSameSite(policy)?;
    manager.AddOrUpdateCookie(&value)
}
