# Disclaimer and project scope

_Last updated: 26 October 2026 · AniVerse 1.0_

AniVerse is a desktop browser and media player with anime-focused discovery and personal organization tools. This notice describes what the software supplies, how it works, and where control lies. It is not a legal determination about every possible use.

## 1. Purpose and distribution

AniVerse combines an Electron/Chromium browser, AniList metadata, optional AniList/MyAnimeList list integrations, a native media player and a local workspace.

Users choose their websites, direct media URLs, local videos and subtitle files. The project does not operate a public episode-hosting platform or internet stream relay. Official signed releases do not bundle streaming-site lists or private browsing recipes.

“Browser” describes the implementation. It does not automatically make a source authorized, create a copyright exception or exempt an application or user from applicable law.

## 2. Website access and automation

Requests originate from the user's computer. Websites and their content-delivery providers serve their pages, scripts, images and media.

AniVerse can inspect rendered page elements to locate search results, series links, episodes and player controls. It follows links on the user's behalf, blocks selected requests/popups, and applies CSS to focus the site's existing player. SUB/DUB and server switches activate controls the site actually exposes.

The website workflow does not extract media URLs into a replacement stream, remove DRM, defeat a login/paywall or solve human-verification challenges on the user's behalf. A challenge may be presented in the site's own session for the user to complete.

Automation can fail when sites change. A focused page still runs website code. Hiding elements and blocking advertisements do not certify a site's licensing, security or privacy practices.

## 3. Storage, playback and networking

“No public media hosting” must be distinguished from ordinary browser and local-player operation:

- Chromium can buffer media and retain cookies, website storage and cache on the device.
- AniVerse stores metadata, library progress, profile data, settings, scene notes, skip maps, plans and collection records locally.
- A collection scan reads selected folder entries and video-file metadata. It does not move or upload videos. A title match does not verify ownership.
- The native player opens a user-provided URL or file. Imported SRT/WebVTT captions are processed locally.
- Opt-in watch insights store observed playing-time and frame-count samples locally; they are not developer analytics uploads.
- Optional casting sends media information to a selected device. Local-file casting can create a temporary token-protected server on the user's local network. This is distinct from a developer-operated public hosting service.
- OAuth sign-in can use a temporary local callback listener. Metadata and updates contact their respective providers.

See [PRIVACY.md](PRIVACY.md). The project does not claim that no data is ever stored or that no network connection is ever opened.

## 4. Content rights and user choices

Episodes, audio, subtitles, artwork, catalogue text and trademarks retain their owners' rights. The software's GPL license does not grant rights to unrelated media displayed through it.

Users should choose sources and files they are entitled to access and comply with applicable law and relevant service terms. A reachable website or locally stored file is not evidence of permission. Copyright exceptions depend on the circumstances and jurisdiction; this project asserts no universal “personal use” exemption. The [U.S. Copyright Office permissions and fair-use FAQ](https://www.copyright.gov/help/faq/faq-fairuse.html) offers general U.S. information, not a worldwide rule.

AniVerse is not intended for unauthorized redistribution or circumvention of access controls. The project does not endorse unlicensed sources or publish a list of them.

## 5. Third-party independence

AniVerse is independent. It is not affiliated with, endorsed by or sponsored by AniList, MyAnimeList, YouTube, Google, NVIDIA, Microsoft or any anime studio, publisher or distributor unless separately stated in writing.

External names identify services or compatible technologies. Their owners control their APIs, terms, accounts and regional availability. Integration does not transfer content rights or create endorsement.

## 6. Playback and hardware limits

Source timing, buffering, codecs and drivers can limit playback. Recovery controls cannot repair every encoding error. Frame-drop statistics do not measure lip sync.

AniVerse requests high-performance graphics and reports available GPU information. Windows, Chromium and the driver decide the actual rendering/decoding path, especially on hybrid laptops. A dedicated GPU, NVIDIA enhancement, AI super resolution, HDR, interpolation or particular performance level is not guaranteed. AniVerse supplies no custom graphics driver.

Spoiler Shield covers specified application elements, not every website, image, result or external discussion. Planner durations, filename parsing and watch insights are estimates that may require correction.

## 7. Copyright concerns and other notices

For material on a third-party website, contact the operator or host that controls it. AniVerse's maintainers cannot remove files from websites they do not operate.

Concerns about this repository's own code, assets or conduct are different. Identify affected files or release assets, the rights involved and a contact method through the project's [GitHub channels](https://github.com/shiwamshoryasharma/AniVerse/issues). Do not publish confidential evidence, credentials or personal information.

For material hosted on GitHub, the [formal GitHub DMCA process](https://docs.github.com/en/site-policy/content-removal-policies/dmca-takedown-policy) remains available. Security concerns should follow [SECURITY.md](SECURITY.md). This notice does not invalidate valid claims, require a public issue, promise an outcome or exclude obligations imposed by law.

## 8. Warranty and liability

AniVerse is provided without warranty under the [GNU General Public License](LICENSE), including its warranty and liability provisions. Exclusions and limitations apply only to the extent permitted by applicable law.

This notice does not create immunity, override mandatory protections, settle third-party rights or replace advice about a specific legal situation. Rights and obligations depend on the relevant facts, law and license.

## 9. Maintenance and changes

AniVerse is a personal project shared on a best-effort basis. Releases may be rare. There is no fixed release schedule, support commitment, service-level agreement or promise of lasting compatibility with a particular website.

The updater does not promise future releases. An outdated or unsupported browser can become incompatible with sites; continued operation is not guaranteed.

This notice may change with the application. Use the version accompanying your release when assessing documented behavior. The About menu contains a shorter notice; this document provides the fuller explanation.

## User-selected content and sources

Users are responsible for the content they watch and the sources they configure. AniVerse's maintainers do not select, endorse or control those sources and are not responsible for users' viewing choices. This notice does not grant content rights, override service terms or guarantee immunity from applicable law.
