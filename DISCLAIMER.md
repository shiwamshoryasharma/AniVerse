# Disclaimer

_Last updated: 23 October 2026_

> **In one sentence:** AniVerse is a desktop web browser with anime-focused features. It hosts nothing, and any legal notice about content must go to the website and hosting provider that actually serve it.

## 1. What AniVerse is

AniVerse is free, open-source desktop software (GPL-3.0) that combines:

- an anime catalogue, schedule and tracker built on **AniList's public API**;
- optional sign-in to **AniList** and **MyAnimeList** to sync the user's own lists through their official APIs;
- a **web browser** that opens websites the user chooses, each in its own isolated session;
- a **media player** for stream links or local files that the user provides.

## 2. AniVerse hosts no content

- The developer of AniVerse **does not host, upload, store, index, stream, sell or distribute** any video, episode, subtitle or other copyrighted content, and runs **no servers** for media of any kind.
- AniVerse ships **without any streaming websites**. The list of websites (`streaming-sites.txt`) is empty until the **user** adds sites to it on their own computer.
- When the user opens a website in AniVerse, its pages, scripts and videos are requested by the user's computer and **delivered directly by that website's own servers**, exactly as in any other browser.

## 3. What AniVerse does with a website's pages

To make websites easier to use, AniVerse acts on the pages that the site has already sent to the user's browser:

- **Web scraping and automated navigation:** it reads the site's search results and links to find the series and episode the user asked for, and follows them on the user's behalf.
- **Ad, tracker and popup blocking**, using public filter lists.
- **A custom CSS overlay**, which hides the rest of the page so that only the **site's own player** is shown.
- **SUB / DUB and server buttons** that click the site's own controls.

AniVerse **does not** download, copy, record, re-host, re-stream or extract the videos. It **does not** circumvent DRM, paywalls, logins or any other technical protection measure. Playback happens inside the website's own player, from the website's own servers.

## 4. No affiliation, no control, no responsibility for third-party sites

- The developer of AniVerse has **no affiliation** with, and **no control** over, any website a user adds. This includes their content, availability, legality, advertising and data practices.
- Whether a website may lawfully offer a given title is a matter between that website, its hosting provider and the rights holders. The developer of AniVerse does **not** endorse, recommend or link to any unlicensed streaming service.
- AniVerse is **not affiliated with, endorsed by or sponsored by** AniList, MyAnimeList, YouTube, Google, or any studio, publisher or distributor. All product names, logos, anime titles, artwork and metadata are the property of their respective owners. Artwork and metadata shown in the app come from AniList's public API.

## 5. Copyright and legal notices (DMCA and similar)

AniVerse does not host the material, so **the developer cannot remove it from the internet**. To have infringing material taken down, send your notice to:

1. **the operator of the website** that serves the material (its contact, abuse or DMCA page); and/or
2. **the hosting provider, CDN or domain registrar** of that website (a WHOIS / IP lookup shows who they are).

Notices sent to the developer of AniVerse about content on third-party websites cannot be acted upon. That includes notices sent through this repository.

This repository contains source code only. If you believe a file **in this repository itself** infringes your rights, open an issue titled “Copyright notice” with a description and the file path, without links to infringing material. It will be reviewed promptly.

## 6. The user's responsibility

By using AniVerse, the user agrees that they:

- choose and are solely responsible for the websites they add and the content they access;
- will comply with the laws of their country and with the terms of the websites and services they use;
- will not use AniVerse to infringe copyright or other rights.

## 7. No warranty, limitation of liability

AniVerse is provided **“as is”, without warranty of any kind**, express or implied, as stated in sections 15 and 16 of the [GNU General Public License v3.0](LICENSE). To the maximum extent permitted by law, the developer and contributors are **not liable** for any claim, damage or other liability arising from the software, from its use, or from any third-party website, service or content accessed with it.

## 8. Changes

This disclaimer may be updated from time to time. The version in the `main` branch of this repository is the current one. The same notice appears in the app under **Settings → About**.
