# Security Policy

## Supported versions

Security fixes go into the latest release and the `main` branch. Please update before reporting.

## Reporting a vulnerability

**Please do not report security problems in public issues.**

Report them privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. If that option isn't available, open a minimal issue that asks for a private channel, without any details.

Please include:

- what is affected (for example the IPC layer, OAuth/deep-link handling, token storage, website session isolation, the installer);
- steps to reproduce, or a proof of concept;
- the impact you expect, and your AniVerse and Windows versions.

You'll get an acknowledgement as soon as possible. Fixes are coordinated before any public disclosure, and reporters are credited unless they prefer otherwise.

## Implemented controls and limitations

[Security architecture](docs/SECURITY-ARCHITECTURE.md) describes the embedded Rust policy, software boundaries, production fuses and residual risks. These controls are defence in depth, not a guarantee that all attacks or vulnerabilities are prevented. Playback compatibility is a required regression check.

## Scope

**In scope:** AniVerse's own code and builds. That includes:
- the Electron main process and preload;
- IPC validation;
- the `aniverse://` protocol and OAuth flow;
- encrypted token storage;
- isolation between website sessions and the app;
- the renderer, including rendering of comments;
- the NSIS installer.

**Out of scope:**
- vulnerabilities in third-party websites a user adds, or in AniList, MyAnimeList or YouTube (report those to their owners);
- issues that need an already-compromised computer;
- missing hardening with no demonstrable impact.
