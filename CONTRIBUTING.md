# Contributing to AniVerse

Thanks for wanting to make AniVerse better! Bug reports, ideas, documentation and code are all welcome.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ground rules

AniVerse is a **browser with anime features, not a content source**. Contributions must keep it that way:

- **No site lists or links.** Don't add streaming-site URLs to code, docs, tests or issues. Tests use neutral placeholder hosts such as `stream-one.test`.
- **No content extraction.** No code that downloads, rips, re-hosts or pulls stream URLs out of third-party websites.
- **No circumvention.** No DRM, paywall or login bypass, and no CAPTCHA/Turnstile solvers or fingerprint spoofing.
- **Official APIs only** for AniList, MyAnimeList and YouTube. No secrets in the repository: OAuth client IDs live in the untracked `config/oauth.json`.
- **Security boundaries stay intact:** a sandboxed renderer with `contextIsolation`, every IPC call validated (zod) in `electron/ipc.ts`, and websites only in their own `persist:src-<id>` sessions.

Pull requests that break these rules can't be merged.

## Reporting bugs and asking for features

- Search [existing issues](https://github.com/shiwamshoryasharma/AniVerse/issues) first.
- Use the issue templates. For bugs, include your Windows version, the AniVerse version, steps to reproduce, what you expected and what happened. Screenshots help, but crop out site names and personal data.
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Development setup

You need Windows 10/11, Node.js 22+, npm and Git.

```bash
git clone https://github.com/shiwamshoryasharma/AniVerse.git
```

```bash
cd AniVerse
```

```bash
npm install
```

```bash
npm run dev
```

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the layers (`app/core` has no framework, `electron/` is the main process, `frontend/` is React). Sign-in setup is in [docs/ACCOUNTS.md](docs/ACCOUNTS.md).

## Making a change

1. Fork the repository and create a branch from `main` (`fix/…`, `feat/…`, `docs/…`).
2. Keep the change focused. Match the surrounding code style, naming and comment density.
3. Add or update tests in `test/unit` for logic changes.
4. Run the checks. Every one must pass:

   ```bash
   npm run typecheck
   ```

   ```bash
   npm run lint
   ```

   ```bash
   npm test
   ```

   ```bash
   npm run build
   ```

5. For UI changes, run the app and include before/after screenshots in the pull request.
6. Write a clear commit message: what changed and why.
7. Open a pull request and fill in the template.

## License of contributions

AniVerse is licensed under the [GNU GPL v3.0](LICENSE). By submitting a contribution you agree that it is your own work and that it is licensed under the same terms.
