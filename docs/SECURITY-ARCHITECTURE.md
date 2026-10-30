# Security boundaries

AniVerse 2.0.1 adds a narrowly scoped Rust policy module alongside Electron's existing sandbox. It reduces specific risks; it cannot prevent every attack, prove every dependency safe, or replace OS security and timely updates.

## Embedded Rust

The module in native/security is compiled to wasm32-unknown-unknown and shipped inside app.asar. It imports no host functions. It cannot read files, launch programs, make network requests or obtain app credentials. Each decision accepts at most 16 KiB of JSON; compiled linear memory is capped at 8 MiB. The app validates its manifest/hash and ABI at startup. An unavailable or trapped policy denies further source requests rather than silently falling back to a permissive parser.

Rust's URL parser canonicalizes hosts and IP representations. The policy rejects privileged schemes, credential-bearing URLs, unconfigured local/private destinations, unrelated main-frame navigation, HTTPS downgrade and invalid app asset destinations. Source networking separately checks resolved addresses with Chromium's resolver. Explicitly configured local IP/.local origins remain usable at their exact origin; they do not authorize other LAN hosts or ports.

The request hook remains installed when ad blocking is off. Cosmetic filters and network-ad matching are optional; source protection is separate. Registered custom protocol handlers are trusted app-owned handlers, not ordinary HTTPS. Browser-local blob/MSE resources and data player frames remain Chromium-owned; their underlying HTTP requests still pass the guard.

## Preserve the player

The policy checks request metadata. It does not proxy, rewrite, decrypt, replace or extract the source stream. Valid public video CDNs and player iframes remain allowed. Existing site controls, audio, quality changes, seeks and playback timing remain authoritative. Main-process API calls, explicitly opened local files and user-selected LAN casting use their existing separate grants.

Source navigation and runtime tests must demonstrate actual advancing decoded media, not merely a page or a marked player. An iframe may disappear while a site swaps servers; this lifecycle event is handled without a main-process rejection.

## Software and package controls

Trusted IPC checks the actual app scheme/host/port and top frame. A URL's opaque origin string alone is not sufficient: app, file and data URLs can otherwise compare as the same null origin. Method lookup uses own properties; inputs, active requests and call rates are bounded before handlers run. Renderer sandboxing, context isolation and disabled Node/worker/subframe integration remain in place. Downloads and device permissions remain denied in source sessions.

The app document receives a restrictive script content policy, nosniff and referrer headers. Its inline styles remain available for React layout; inline scripts and eval are not granted. Local media grants require the local capability host and only support read methods.

Release fuses disable RunAsNode, NODE_OPTIONS and Node CLI inspection; enable ASAR integrity checking and ASAR-only loading; and remove extra file-protocol privileges. Static app binaries remain signed. The old main-inspector Playwright launcher is intentionally unsuitable for fused production binaries; test/e2e/security.mjs tests those binaries through a renderer-only loopback CDP connection.

## Limits and tradeoffs

DNS checks add a cached asynchronous lookup for a new public host. Lookup failure denies that request. The lookup and Chromium connection are separate operations; this does not prove elimination of every DNS-rebinding or network race. Corporate/split-DNS sources that resolve to private addresses can require an explicitly local source URL. Do not weaken the policy automatically to make a failed test pass; verify the cause and preserve ordinary public playback.

RPC budgets begin after Electron has cloned the input and do not make a compromised renderer incapable of resource exhaustion. WebAssembly memory isolation does not guarantee freedom from logic bugs or CPU exhaustion. Chromium, codecs, GPU drivers, Rust dependencies and the OS still require maintenance. A local administrator can replace the whole installed app. No antivirus, OS firewall, cloud service, telemetry upload or remote scanning service is installed.

The precise dependency versions are in Cargo.lock. The bundled security-LICENSES.txt contains dependency notices, including build-time dependencies conservatively. Build and download caches belong in test/cache.

[Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security/) · [Rust target characteristics](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html)
