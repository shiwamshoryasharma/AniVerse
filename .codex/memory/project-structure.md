# Project folder map

Inspected 2026-10-29, Asia/Calcutta, against the working tree at `E:\14-OCT-2026\aniverse`. This map covers maintained source and support folders; dependency, build and test-cache internals were excluded from the source inventory. Read [architecture](architecture.md) for execution flow and coordinated changes.

~~~text
aniverse/
|-- AGENTS.md                   Codex memory/skill routing and user requirements
|-- package.json                Root scripts and application dependencies
|-- package-lock.json           npm dependency lock
|-- tsconfig.json               Core, Electron and unit-test TypeScript settings
|-- electron-builder.yml        Base packaging, installer and protocol settings
|-- app/
|   |-- shared/                 Types, RPC/events, release, graphics, playback,
|   |                           workspace, subtitle and portable-theme helpers
|   `-- core/
|       |-- config/             Source-list parsing
|       |-- db/                 SQLite Store and ordered migrations
|       |-- metadata/           AniList client
|       |-- net/                HTTP/cache/rate limiting and challenge detection
|       |-- sources/            Registry, web discovery, recipes, YouTube matching
|       |-- sync/               Providers, queue service and reconciliation
|       `-- *.ts                Settings, comments, workspace and utilities
|-- electron/
|   |-- main.ts                 Composition, application lifecycle and RPC handlers
|   |-- preload.ts              Sandboxed window.aniverse bridge
|   |-- ipc.ts                  Input schemas and trusted-sender dispatch
|   |-- sessions.ts             Source partitions and webview guards
|   |-- siteNavigator.ts        Rendered site navigation and source options
|   |-- sitePage.ts             Isolated-world DOM scripts and player focus
|   |-- media.ts, mediaPage.ts   Local-media grants and website media observation
|   |-- collection.ts           Local folder selection, scans and confirmed matching
|   |-- accounts.ts, oauth.ts   Main-process tokens and sign-in transactions
|   |-- deepLink.ts, paths.ts   OS callback and profile/config path handling
|   |-- updater.ts              Installed-app update state
|   |-- updateSignature.ts      Pinned signer verification
|   |-- adblock.ts, cloudflare.ts, configWatcher.ts
|   `-- cast/                  CASTV2, discovery and local-file serving lifecycle
|-- frontend/
|   |-- index.html, vite.config.ts, tsconfig.json
|   |-- public/                 Renderer public assets
|   `-- src/
|       |-- main.tsx            Hash routes, query client and providers
|       |-- pages/              Home, Browse, Details, Watch, Schedule, Library,
|       |                       Sources, Workspace, Player, Profile and Settings
|       |-- components/         Existing shell, controls, episode toolkit, release,
|       |                       graphics, theme, comments and website surfaces
|       |-- player/             VideoPlayer, SubtitleStudio and Cast integration
|       |-- lib/                Typed bridge, queries, formatting and UI helpers
|       |-- styles/             app.css, controls.css and workspace.css
|       `-- assets/             Original cat frames and graphics illustrations
|-- config/                     Public examples/filters/pins, FFmpeg pin, private local config
|-- scripts/                    Dev/build, artwork import, signing and release tools
|-- test/
|   |-- vitest.config.ts        Unit-test discovery, Node/fork execution, cache path
|   |-- unit/                  Maintained regression suites
|   |-- e2e/
|   |   `-- drivers/            Native in-process Electron test drivers
|   |-- fixtures/              Neutral HTML and metadata fixtures
|   |-- images/                Required image inputs for generation/validation
|   |-- cache/                 Isolated profiles, tool/temp caches and scratch scripts
|   `-- artifacts/             Generated reports, screenshots and validation outputs
|-- docs/                       Architecture, accounts, playback, installer, updates
|   |-- releases/              Release notes
|   `-- screenshots/           Documentation assets; not model-test input substitutes
|-- assets/installer/           Installer source wallpapers
|-- assets/anime4k/             Pinned shader source and license notices
|-- build/                     Maintained icon and installer.nsh
|   |-- installer/             Generated installer artwork, ignored by Git
|   `-- vendor/ffmpeg/         Verified embedded tools, ignored by Git
|-- dist/                      Generated Electron/renderer bundles
|-- release/                   Packaged applications, installers and update files
|-- .github/                   Issue and pull-request templates
|-- .claude/                   Existing Claude skills and historical memory
|-- .codex/
|   |-- memory/                Engineering observations and provenance
|   `-- skills/                Project-specific SKILL.md and agents/openai.yaml
`-- node_modules/              Installed dependencies; do not edit as project source
~~~

`.idea/`, `.prompts/` and private root notes also exist. They are not testing destinations. Do not copy their contents or configured site identities into shared context.

## Build and runtime entrypoints

- `npm run dev` runs `scripts/dev.mjs`: Vite on `127.0.0.1:5273`, esbuild watch and Electron restarts. The renderer needs the Electron preload; a browser-only preview lacks `window.aniverse`.
- `npm run build` runs `scripts/build.mjs`: `electron/main.ts` and `preload.ts` become CommonJS under `dist/electron/`; Vite writes `dist/renderer/`.
- `npm start` launches Electron using `package.json` main `dist/electron/main.cjs`.
- Package metadata declares version 1.5.2, Electron 44.9.3, React 19.3.1, TypeScript 6.0.3 and Vite ^8.3.5. These are declarations from the inspected package, not current installed-runtime guarantees.

## Context upkeep

Keep module behavior in [architecture](architecture.md) and [workspace](workspace.md), durable constraints in [decisions](decisions.md), testing details in [testing](testing.md), and dated outcomes in [status](status.md). Update this map when paths move; do not copy source implementations into memory.
