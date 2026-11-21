use super::{parse_expected, same_secret, Attempt, Grant};
use crate::RpcError;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{
    webview::NewWindowResponse, Manager, Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tokio::sync::oneshot;
use webview2_com::{
    take_pwstr, LaunchingExternalUriSchemeEventHandler, Microsoft::Web::WebView2::Win32::*,
    NavigationCompletedEventHandler, PermissionRequestedEventHandler,
    WebResourceRequestedEventHandler,
};
use windows::{
    core::{w, Interface, PWSTR},
    Win32::System::Com::IStream,
};

type ResultSender = Arc<Mutex<Option<oneshot::Sender<Result<Grant, RpcError>>>>>;

#[derive(Clone)]
struct Boundary {
    provider: &'static str,
    callback: &'static str,
    state: Arc<str>,
    result: ResultSender,
}

impl Boundary {
    fn complete(&self, result: Result<Grant, RpcError>) {
        if let Ok(mut sender) = self.result.lock() {
            if let Some(sender) = sender.take() {
                let _ = sender.send(result);
            }
        }
    }

    fn receive(&self, raw: &str) {
        if let Some(callback) = parse_expected(raw, self.callback, self.provider) {
            if same_secret(&callback.state, &self.state) {
                self.complete(Ok(callback.grant));
            }
        }
    }
}

pub(super) async fn authorise(
    owner: &Webview,
    authorization: reqwest::Url,
    provider: &str,
    callback: &'static str,
    state: &str,
    attempt: &Attempt<'_>,
) -> Result<Grant, RpcError> {
    if std::env::var_os("WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER").is_some()
        || std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
            .is_ok_and(|args| args.to_ascii_lowercase().contains("--remote-debugging"))
    {
        return Err(RpcError::new(
            "unavailable",
            "Restart AniVerse2 without browser debugging to sign in.",
        ));
    }
    let (provider, name) = match provider {
        "anilist" => ("anilist", "AniList"),
        "mal" => ("mal", "MyAnimeList"),
        _ => return Err(unavailable()),
    };
    if !allowed(&authorization, provider, false) {
        return Err(unavailable());
    }
    let data = owner
        .app_handle()
        .path()
        .app_cache_dir()
        .map_err(|_| unavailable())?
        .join("oauth-webview")
        .join(provider);
    let (send, mut receive) = oneshot::channel();
    let boundary = Boundary {
        provider,
        callback,
        state: state.into(),
        result: Arc::new(Mutex::new(Some(send))),
    };
    let navigation = boundary.clone();
    let guest = WebviewWindowBuilder::new(
        owner.app_handle(),
        format!("oauth-{}", uuid::Uuid::new_v4()),
        WebviewUrl::External("about:blank".parse().map_err(|_| unavailable())?),
    )
    .title(format!("Sign in to {name}"))
    .inner_size(580., 720.)
    .center()
    .visible(false)
    .incognito(true)
    .data_directory(data)
    .devtools(false)
    .on_navigation(move |url| {
        if url.scheme() == "aniverse" {
            navigation.receive(url.as_str());
            return false;
        }
        if url.as_str() == "about:blank" || allowed(url, provider, false) {
            return true;
        }
        navigation.complete(Err(provider_rejected()));
        false
    })
    .on_new_window(|_, _| NewWindowResponse::Deny)
    .on_download(|_, _| false)
    .build()
    .map_err(|_| unavailable())?;
    let closed = boundary.clone();
    guest.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            closed.complete(Err(RpcError::new("unauthorised", "Sign-in was cancelled.")));
        }
    });
    let result = async {
        install(&guest, boundary).await?;
        attempt.check()?;
        guest.navigate(authorization).map_err(|_| unavailable())?;
        guest.show().map_err(|_| unavailable())?;
        let _ = guest.set_focus();
        loop {
            attempt.check()?;
            if let Ok(result) = tokio::time::timeout(Duration::from_millis(140), &mut receive).await
            {
                return result.map_err(|_| unavailable())?;
            }
        }
    }
    .await;
    let _ = guest.destroy();
    result
}

async fn install(guest: &WebviewWindow, boundary: Boundary) -> Result<(), RpcError> {
    let (send, receive) = oneshot::channel();
    guest
        .with_webview(move |platform| {
            let installed = unsafe {
                platform
                    .controller()
                    .CoreWebView2()
                    .and_then(|core| configure(&core, &platform.environment(), boundary))
            };
            let _ = send.send(installed.is_ok());
        })
        .map_err(|_| unavailable())?;
    match tokio::time::timeout(Duration::from_secs(10), receive).await {
        Ok(Ok(true)) => Ok(()),
        _ => Err(unavailable()),
    }
}

/// The browser starts hidden on a blank page and stays there until these guards are active.
unsafe fn configure(
    core: &ICoreWebView2,
    environment: &ICoreWebView2Environment,
    boundary: Boundary,
) -> windows::core::Result<()> {
    let settings = core.Settings()?;
    settings.SetAreDevToolsEnabled(false)?;
    settings.SetAreHostObjectsAllowed(false)?;
    settings.SetIsWebMessageEnabled(false)?;
    settings.SetAreDefaultContextMenusEnabled(false)?;
    let options = settings.cast::<ICoreWebView2Settings4>()?;
    options.SetIsPasswordAutosaveEnabled(false)?;
    options.SetIsGeneralAutofillEnabled(false)?;
    let mut registration = 0;
    core.add_PermissionRequested(
        &PermissionRequestedEventHandler::create(Box::new(|_, arguments| {
            if let Some(arguments) = arguments {
                arguments.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
            }
            Ok(())
        })),
        &mut registration,
    )?;

    let external = boundary.clone();
    core.cast::<ICoreWebView2_18>()?
        .add_LaunchingExternalUriScheme(
            &LaunchingExternalUriSchemeEventHandler::create(Box::new(move |_, arguments| {
                if let Some(arguments) = arguments {
                    arguments.SetCancel(true)?;
                    let mut origin = PWSTR::null();
                    arguments.InitiatingOrigin(&mut origin)?;
                    if reqwest::Url::parse(&take_pwstr(origin))
                        .is_ok_and(|url| allowed(&url, external.provider, false))
                    {
                        let mut uri = PWSTR::null();
                        arguments.Uri(&mut uri)?;
                        external.receive(&take_pwstr(uri));
                    }
                }
                Ok(())
            })),
            &mut registration,
        )?;

    let rejected = boundary.clone();
    core.add_NavigationCompleted(
        &NavigationCompletedEventHandler::create(Box::new(move |_, arguments| {
            if let Some(arguments) = arguments {
                if let Ok(arguments) =
                    arguments.cast::<ICoreWebView2NavigationCompletedEventArgs2>()
                {
                    let mut status = 0;
                    if arguments.HttpStatusCode(&mut status).is_ok() && status >= 400 {
                        rejected.complete(Err(provider_rejected()));
                    }
                }
            }
            Ok(())
        })),
        &mut registration,
    )?;

    core.cast::<ICoreWebView2_22>()?
        .AddWebResourceRequestedFilterWithRequestSourceKinds(
            w!("*"),
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
            COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
        )?;
    let denied = environment.CreateWebResourceResponse(
        None::<&IStream>,
        403,
        w!("Blocked"),
        w!("Cache-Control: no-store"),
    )?;
    core.add_WebResourceRequested(
        &WebResourceRequestedEventHandler::create(Box::new(move |_, arguments| {
            if let Some(arguments) = arguments {
                let mut uri = PWSTR::null();
                arguments.Request()?.Uri(&mut uri)?;
                if !reqwest::Url::parse(&take_pwstr(uri))
                    .is_ok_and(|url| allowed(&url, boundary.provider, true))
                {
                    arguments.SetResponse(&denied)?;
                }
            }
            Ok(())
        })),
        &mut registration,
    )
}

pub(super) fn allowed(url: &reqwest::Url, provider: &str, assets: bool) -> bool {
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    match provider {
        "anilist" => {
            matches!(host, "anilist.co" | "www.anilist.co")
                || (assets && (host.ends_with(".anilist.co") || host == "s4.anili.st"))
        }
        "mal" => {
            matches!(host, "myanimelist.net" | "www.myanimelist.net")
                || (assets && host.ends_with(".myanimelist.net"))
        }
        _ => false,
    }
}

fn provider_rejected() -> RpcError {
    RpcError::new(
        "unavailable",
        "The provider could not complete sign-in in the compatibility window.",
    )
}

fn unavailable() -> RpcError {
    RpcError::new(
        "unavailable",
        "Could not open the protected sign-in window.",
    )
}
