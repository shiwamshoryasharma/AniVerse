use super::{native, page, Session};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::{collections::HashSet, sync::atomic::Ordering};
use tauri::Url;

const MAX_IMAGE: usize = 2 * 1024 * 1024;
const MAX_PREVIEWS: usize = 16;

#[derive(Clone, Copy)]
struct Owner {
    page: u64,
    job: u64,
    episode: (i64, usize),
}
impl Owner {
    fn current(self, session: &Session) -> bool {
        !session.closed.load(Ordering::Acquire)
            && !session.browsing_private()
            && session.page_generation.load(Ordering::Acquire) == self.page
            && session.job.load(Ordering::Acquire) == self.job
            && session.active_episode.lock().ok().and_then(|value| *value) == Some(self.episode)
    }
}

fn candidates(raw: &Value, cards: &Value, near: usize) -> Vec<(u64, String)> {
    let mut seen = HashSet::new();
    let mut rows = raw
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let episode = row["episode"].as_u64().filter(|n| (1..=5000).contains(n))?;
            if !seen.insert(episode)
                || !cards
                    .as_array()?
                    .iter()
                    .any(|card| card["episode"] == episode && card["thumbnail"].is_null())
            {
                return None;
            }
            let url = row["thumbnail"].as_str().filter(|url| url.len() <= 8192)?;
            let parsed = Url::parse(url).ok()?;
            if !matches!(parsed.scheme(), "http" | "https")
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.fragment().is_some()
            {
                return None;
            }
            Some((episode, url.to_owned()))
        })
        .collect::<Vec<_>>();
    rows.sort_by_key(|(episode, _)| episode.abs_diff(near as u64));
    rows.truncate(MAX_PREVIEWS);
    rows
}

fn allowed_image(session: &Session, url: &str) -> bool {
    if aniverse_security::allows_source_network(url, session.source.base.as_str()) {
        return true;
    }
    #[cfg(feature = "isolated-test")]
    if super::fixture_source(&session.source.base) {
        return Url::parse(url).is_ok_and(|target| {
            target.scheme() == "http"
                && target.host_str() == Some("127.0.0.1")
                && target.port().is_some()
                && std::env::var("ANIVERSE2_TEST_FRAME_ORIGIN")
                    .is_ok_and(|origin| origin == target.origin().ascii_serialization())
        });
    }
    false
}

fn image_bytes(value: &Value) -> Option<Vec<u8>> {
    if value["base64Encoded"] != true {
        return None;
    }
    let content = value["content"]
        .as_str()
        .filter(|body| body.len() <= MAX_IMAGE * 4 / 3 + 4)?;
    let bytes = STANDARD
        .decode(content)
        .ok()
        .filter(|bytes| bytes.len() <= MAX_IMAGE)?;
    let valid = bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(b"\xff\xd8\xff")
        || bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
        || (bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"))
        || (bytes.get(4..8) == Some(b"ftyp")
            && matches!(bytes.get(8..12), Some(b"avif" | b"avis")));
    valid.then_some(bytes)
}

fn image_resource<'a>(tree: &'a Value, url: &str) -> Option<&'a str> {
    let mime = [
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "image/avif",
    ];
    tree["resources"]
        .as_array()?
        .iter()
        .any(|resource| {
            resource["url"] == url
                && resource["type"] == "Image"
                && resource["mimeType"]
                    .as_str()
                    .is_some_and(|value| mime.contains(&value))
        })
        .then(|| tree["frame"]["id"].as_str())
        .flatten()
}

/// Read only DOM-selected image resources through the owning WebView2 session.
/// Browser image requests retain the existing source cookies, CSP and network/ad guards;
/// only small decoded JPEGs cross the trusted renderer bridge.
pub(super) async fn fill(session: &Session, context: (i64, usize), cards: &mut Value) {
    let owner = Owner {
        page: session.page_generation.load(Ordering::Acquire),
        job: session.job.load(Ordering::Acquire),
        episode: context,
    };
    if !owner.current(session) {
        return;
    }
    let Ok(raw) = page(session, json!({"op":"episodeCards","slug":null})).await else {
        return;
    };
    if !owner.current(session) {
        return;
    }
    let urls = candidates(&raw, cards, context.1)
        .into_iter()
        .filter(|(_, url)| allowed_image(session, url))
        .collect::<Vec<_>>();
    if urls.is_empty() {
        return;
    }
    let _ = native::devtools(&session.view, "Page.enable", json!({})).await;
    let Ok(mut tree) = native::devtools(&session.view, "Page.getResourceTree", json!({})).await
    else {
        return;
    };
    let unloaded = urls
        .iter()
        .filter(|(_, url)| image_resource(&tree["frameTree"], url).is_none())
        .map(|(_, url)| url)
        .collect::<Vec<_>>();
    if !unloaded.is_empty() && owner.current(session) {
        // Do not scroll, click, seek, change the source DOM, or clone its video.
        // Normal browser image loads also make lazy images available to resource reads.
        let script = format!(
            r#"(async () => {{
            const images = {unloaded}.map(url => new Image());
            globalThis.__avEpisodeArtworkImages = images;
            await Promise.all(images.map((image,index) => new Promise(resolve => {{
                const finish = () => {{clearTimeout(timer);image.onload=image.onerror=null;resolve(null);}};
                const timer=setTimeout(finish,2500); image.onload=image.onerror=finish;
                image.decoding='async';image.src={unloaded}[index];
            }})));
            return true;
        }})()"#,
            unloaded = json!(unloaded)
        );
        let _ = native::image_script(session, script).await;
        if owner.current(session) {
            if let Ok(next) =
                native::devtools(&session.view, "Page.getResourceTree", json!({})).await
            {
                tree = next;
            }
        }
    }

    let budget = MAX_PREVIEWS.saturating_sub(
        cards
            .as_array()
            .into_iter()
            .flatten()
            .filter(|row| row["thumbnail"].is_string())
            .count(),
    );
    let mut added = 0;
    for (episode, url) in urls {
        if !owner.current(session) || added >= budget {
            break;
        }
        let Some(frame) = image_resource(&tree["frameTree"], &url) else {
            continue;
        };
        let Ok(content) = native::image_resource(session, frame, &url).await else {
            continue;
        };
        if !owner.current(session) {
            break;
        }
        let Some(bytes) = image_bytes(&content) else {
            continue;
        };
        let encoded = STANDARD.encode(bytes);
        let script = format!(
            r#"(async () => {{
            const bytes=Uint8Array.from(atob({encoded}),c=>c.charCodeAt(0));
            const image=await createImageBitmap(new Blob([bytes]));
            try {{
                if(image.width<64 || image.height<36 || image.width*image.height>16777216) return null;
                const scale=Math.min(1,192/image.width,108/image.height);
                const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));
                const ctx=canvas.getContext('2d');if(!ctx) return null;
                ctx.drawImage(image,0,0,canvas.width,canvas.height);
                const jpeg=canvas.toDataURL('image/jpeg',0.65);
                return jpeg.length<=10240 ? jpeg : null;
            }} finally {{ image.close(); }}
        }})()"#,
            encoded = json!(encoded)
        );
        let Ok(jpeg) = native::image_script(session, script).await else {
            continue;
        };
        if !owner.current(session) {
            break;
        }

        if let Some(value) = jpeg
            .as_str()
            .filter(|value| super::navigation::valid_episode_thumbnail(value))
        {
            if let Some(row) = cards
                .as_array_mut()
                .and_then(|rows| rows.iter_mut().find(|row| row["episode"] == episode))
            {
                row["thumbnail"] = json!(value);
                added += 1;
            }
        }
    }
    if owner.current(session) {
        let _ = native::image_script(
            session,
            "delete globalThis.__avEpisodeArtworkImages; true".into(),
        )
        .await;
    } else if let Some(rows) = cards.as_array_mut() {
        for row in rows {
            row["thumbnail"] = Value::Null;
        }
    }
}

#[cfg(test)]
#[path = "../../../../test/tauri-compat/episode-artwork.rs"]
mod tests;
