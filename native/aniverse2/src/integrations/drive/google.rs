use super::{
    form, network, open_browser, response_json, valid_token, Credentials, Service, Tokens,
};
use crate::RpcError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::Url;
use sha2::{Digest, Sha256};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::timeout,
};
use windows_sys::Win32::Security::Cryptography::{
    BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
};

const AUTH: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN: &str = "https://oauth2.googleapis.com/token";

pub(super) async fn authorise(
    service: &Service,
    credentials: &Credentials,
    shared: bool,
    cancel: &AtomicBool,
) -> Result<Tokens, RpcError> {
    if cancel.load(Ordering::Acquire) {
        return Err(cancelled());
    }
    let state = random::<32>()?;
    let verifier = random::<48>()?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|_| network())?;
    let authority = listener.local_addr().map_err(|_| network())?.to_string();
    let redirect = format!("http://{authority}/oauth2callback");
    let scope = if shared {
        "https://www.googleapis.com/auth/drive"
    } else {
        "https://www.googleapis.com/auth/drive.file"
    };
    let mut browser = Url::parse(AUTH).map_err(|_| network())?;
    browser.query_pairs_mut().extend_pairs([
        ("client_id", credentials.client_id.as_str()),
        ("redirect_uri", &redirect),
        ("response_type", "code"),
        ("scope", scope),
        ("state", &state),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
        ("access_type", "offline"),
        ("prompt", "consent select_account"),
    ]);
    open_browser(&browser)?;
    let deadline = Instant::now() + Duration::from_secs(180);
    while Instant::now() < deadline {
        if cancel.load(Ordering::Acquire) {
            return Err(cancelled());
        }
        let Ok(connection) = timeout(Duration::from_millis(200), listener.accept()).await else {
            continue;
        };
        let (mut socket, _) = connection.map_err(|_| network())?;
        if let Ok(Ok(Some(grant))) = timeout(
            Duration::from_secs(1),
            callback(&mut socket, &authority, &state),
        )
        .await
        {
            drop(listener);
            let code = grant
                .ok_or_else(|| RpcError::new("unauthorised", "Google sign-in was declined."))?;
            return tokens(
                service,
                credentials,
                &[
                    ("redirect_uri", &redirect),
                    ("grant_type", "authorization_code"),
                    ("code", &code),
                    ("code_verifier", &verifier),
                ],
                "",
            )
            .await;
        }
    }
    Err(RpcError::new(
        "unavailable",
        "Google sign-in timed out. Try again.",
    ))
}

pub(super) async fn tokens(
    service: &Service,
    credentials: &Credentials,
    params: &[(&str, &str)],
    previous: &str,
) -> Result<Tokens, RpcError> {
    let mut args = vec![("client_id", credentials.client_id.as_str())];
    if !credentials.client_secret.is_empty() {
        args.push(("client_secret", credentials.client_secret.as_str()));
    }
    args.extend_from_slice(params);
    let request = form(service.client.post(TOKEN), &args)?;
    let data = response_json(service.send(request).await?, 64_000).await?;
    let access = data["access_token"]
        .as_str()
        .filter(|token| valid_token(token))
        .ok_or_else(network)?;
    let refresh = if data["refresh_token"].is_null() {
        previous
    } else {
        data["refresh_token"]
            .as_str()
            .filter(|token| valid_token(token))
            .ok_or_else(network)?
    };
    let seconds = data["expires_in"]
        .as_i64()
        .filter(|seconds| (1..=86_400).contains(seconds))
        .ok_or_else(network)?;
    Ok(Tokens {
        access_token: access.to_owned(),
        refresh_token: refresh.to_owned(),
        expires_at: chrono::Utc::now().timestamp_millis() + seconds * 1000,
    })
}

async fn callback(
    socket: &mut TcpStream,
    authority: &str,
    state: &str,
) -> std::io::Result<Option<Option<String>>> {
    let mut bytes = [0u8; 16_384];
    let mut used = 0;
    while used < bytes.len() {
        let got = socket.read(&mut bytes[used..]).await?;
        if got == 0 {
            break;
        }
        used += got;
        if bytes[..used].windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let grant = std::str::from_utf8(&bytes[..used])
        .ok()
        .and_then(|request| parse_callback(request, authority, state));
    let (status, message) = if grant.is_some() {
        ("200 OK", "Return to AniVerse to finish Google sign-in.")
    } else {
        ("400 Bad Request", "Invalid sign-in response.")
    };
    let response = format!("HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{message}", message.len());
    let _ = socket.write_all(response.as_bytes()).await;
    Ok(grant)
}

fn parse_callback(request: &str, authority: &str, expected: &str) -> Option<Option<String>> {
    let (header, _) = request.split_once("\r\n\r\n")?;
    let mut lines = header.split("\r\n");
    let mut first = lines.next()?.split_whitespace();
    if first.next()? != "GET" {
        return None;
    }
    let target = first.next()?;
    if !matches!(first.next()?, "HTTP/1.1" | "HTTP/1.0")
        || first.next().is_some()
        || !target.starts_with("/oauth2callback?")
    {
        return None;
    }
    let mut host = lines.filter_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("Host").then_some(value.trim())
    });
    if host.next()? != authority || host.next().is_some() {
        return None;
    }
    let url = Url::parse(&format!("http://{authority}{target}")).ok()?;
    if url.path() != "/oauth2callback" || url.fragment().is_some() {
        return None;
    }
    let mut states = url
        .query_pairs()
        .filter_map(|(key, value)| (key == "state").then_some(value));
    let state = states.next()?;
    if states.next().is_some() || !same(state.as_bytes(), expected.as_bytes()) {
        return None;
    }
    let mut codes = url
        .query_pairs()
        .filter_map(|(key, value)| (key == "code").then_some(value));
    let code = codes.next().filter(|code| valid_token(code));
    if codes.next().is_some() {
        return None;
    }
    let denied = url.query_pairs().any(|(key, _)| key == "error");
    Some(if denied {
        None
    } else {
        code.map(|code| code.into_owned())
    })
}

fn same(first: &[u8], second: &[u8]) -> bool {
    first.len() == second.len()
        && first
            .iter()
            .zip(second)
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0
}

fn random<const LEN: usize>() -> Result<String, RpcError> {
    let mut bytes = [0u8; LEN];
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            LEN as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status < 0 {
        return Err(network());
    }
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub(super) fn cancelled() -> RpcError {
    RpcError::new("unavailable", "Google sign-in cancelled.")
}
#[cfg(test)]
#[path = "../../../../../test/tauri-compat/google-oauth.rs"]
mod tests;
