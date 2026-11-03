// Release build: the Windows installer, signed with AniVerse's code-signing certificate and
// shipped without any streaming-site list (public builds start with an empty source list;
// only filters.txt is bundled). Run through `npm run dist:signed`, which bundles first.
// Output in release/: AniVerse-Setup-<version>.exe, its .blockmap and latest.yml — the three
// files a GitHub release needs for self-update (npm run release uploads them).
//
// The certificate is taken from the Windows certificate store (CurrentUser\My) by the SHA-1
// thumbprint in config/signing.json, or ANIVERSE_SIGN_SHA1. Its private key never leaves the
// store. The fingerprints are published in README.md so users can check a download.
import builder from 'electron-builder';
import { root, writeReleaseConfig } from './releaseConfig.mjs';

// The executable cache can reuse a stale ASAR integrity resource on repeated Windows builds.
// Re-sign the current executable; keep ASAR integrity validation enabled.
process.env.ELECTRON_BUILDER_DISABLE_BUILD_CACHE = 'true';

const { file, sha1 } = writeReleaseConfig();
await builder.build({
  projectDir: root,
  targets: builder.Platform.WINDOWS.createTarget('nsis', builder.Arch.x64),
  config: file,
  publish: 'never',
});
console.log(`Signed installer in release/ (certificate ${sha1}).`);
