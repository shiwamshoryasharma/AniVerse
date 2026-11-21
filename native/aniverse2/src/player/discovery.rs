use super::{failure, invalid, native, navigation, resolve_source, Service};
use crate::{profile, sources, RpcError};
use serde_json::Value;
use std::{
    path::Path,
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use tauri::{Emitter, Url, Webview};

// Reads only a public GET search input or same-origin search suggestion. No form
// submission, hidden field values, local storage or page credentials are read.
const PROBE: &str = r#"(() => {
  const fields = /^(q|query|keyword|keywords|search|s|k|term|title|name)$/i;
  const searchPath = /(?:^|\/)(search|find|browse)(?:\/|$)/i;
  const parse = raw => {
    if (raw?.length > 2000) return null;
    try {
      const url = new URL(raw || location.pathname, location.href);
      return url.origin === location.origin && !url.username && !url.password &&
        !/(?:^|\/)(?:api|admin|auth|oauth|login|log-in|sign-in|signin|account|verify)(?:\/|$)/i.test(url.pathname)
        ? url : null;
    } catch { return null; }
  };
  const visible = node => node.getClientRects().length && node.checkVisibility({checkVisibilityCSS:true,checkOpacity:true});
  const candidate = (url, key, via) => ({path:url.origin + url.pathname, key, via});
  for (const form of Array.prototype.slice.call(document.forms,0,64)) {
    if (form.method !== 'get') continue;
    const action = parse(form.getAttribute('action'));
    if (!action || action.search) continue;
    const input = Array.prototype.slice.call(form.elements,0,64).find(node =>
      node.tagName === 'INPUT' && !node.disabled && fields.test(node.name) &&
      (node.type === 'search' || node.type === 'text' && searchPath.test(action.pathname)) && visible(node));
    if (input) return candidate(action,input.name,'form');
  }
  const links = document.querySelectorAll('a[href]');
  for (let index = 0; index < Math.min(links.length,300); index++) {
    const link = links[index];
    const href = parse(link.getAttribute('href'));
    if (!href || !searchPath.test(href.pathname) || !visible(link)) continue;
    const parameters = [...href.searchParams];
    if (parameters.length === 1 && fields.test(parameters[0][0]) && parameters[0][1])
      return candidate(href,parameters[0][0],'ui');
  }
  return null;
})()"#;

pub(super) async fn discover(
    service: &Service,
    owner: &Webview,
    root: &Path,
    input: &Value,
) -> Result<Value, RpcError> {
    ensure_public_context(root)?;
    let id = input["id"].as_str().ok_or_else(invalid)?;
    let source = resolve_source(root, id)?;
    if source.kind != "web" {
        return Err(invalid());
    }
    let base = source.base.clone();
    let _permit = service.catalogue.try_acquire().map_err(|_| {
        failure("Wait for the current source search to finish before checking again.")
    })?;
    let session = service.create_discovery_view(owner, source).await?;
    let alive = || {
        !session.closed.load(Ordering::Acquire)
            && session.blocked.lock().is_ok_and(|block| block.is_none())
    };
    if !navigation::load(&session, base.clone(), &alive).await {
        return Err(failure("Could not open this site's public search page."));
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut found = None;
    while alive() && Instant::now() < deadline {
        if session
            .view
            .url()
            .is_ok_and(|current| current.origin() == base.origin())
        {
            if let Ok(value) = native::read(&session, PROBE).await {
                found = template(&value, &base);
            }
            if found.is_some() {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    if !alive() {
        return Err(failure(
            "The source redirected away from its configured search origin.",
        ));
    }
    drop(session);
    ensure_public_context(root)?;
    let (selected, via) = found
        .as_ref()
        .map_or((None, "form"), |(url, via)| (Some(url.as_str()), *via));
    let (updated, entries) = sources::save_discovery(root, id, &base, selected, via)?;
    let _ = owner.emit_to(owner.label(), "aniverse:sources/changed", entries);
    Ok(updated)
}

fn ensure_public_context(root: &Path) -> Result<(), RpcError> {
    if profile::request(root, "privacy.state", Value::Null)?["incognito"] == true {
        return Err(RpcError::new(
            "unauthorised",
            "Search discovery is disabled in private browsing.",
        ));
    }
    Ok(())
}

fn template(value: &Value, base: &Url) -> Option<(String, &'static str)> {
    let mut url = Url::parse(value["path"].as_str()?).ok()?;
    let protected = [
        "api", "admin", "auth", "oauth", "login", "log-in", "sign-in", "signin", "account",
        "verify",
    ];
    if url.origin() != base.origin()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path().contains('%')
        || url.path().split('/').any(|piece| {
            protected
                .iter()
                .any(|restricted| piece.eq_ignore_ascii_case(restricted))
        })
    {
        return None;
    }
    let key = value["key"].as_str()?;
    if ![
        "q", "query", "keyword", "keywords", "search", "s", "k", "term", "title", "name",
    ]
    .iter()
    .any(|known| key.eq_ignore_ascii_case(known))
    {
        return None;
    }
    let via = match value["via"].as_str()? {
        "form" => "form",
        "ui" => "ui",
        _ => return None,
    };
    url.query_pairs_mut().append_pair(key, "ANIVERSEQUERYTOKEN");
    let raw = url.as_str();
    if raw.matches("ANIVERSEQUERYTOKEN").count() != 1 {
        return None;
    }
    let template = raw.replace("ANIVERSEQUERYTOKEN", "{query}");
    sources::search_template(Some(&template), base)?;
    Some((template, via))
}
