export type ChangeKind = 'added' | 'improved' | 'fixed';
export type ChangeIcon = 'layout' | 'cast' | 'sparkles' | 'cloud' | 'history' | 'shield' | 'fix';
export interface ReleaseNote {
  version: string; date: string; title: string; summary: string;
  items: { kind: ChangeKind; icon: ChangeIcon; title: string; description: string; action?: { label: string; path: string } }[];
}
export const RELEASES: ReleaseNote[] = [
  {version:'2.0.2',date:'2026-10-31',title:'Find the right arc. See the episode.',
   summary:'Generic series matching, actual episode stills and source-confirmed audio filters.',
   items:[
    {kind:'fixed',icon:'fix',title:'Named arcs and seasons resolve correctly',description:'A source can use an arc name while AniList uses a Season 2 alias. Missing numbers remain unknown; explicit seasons, parts and cours stay separate across English, romaji and Japanese titles.'},
    {kind:'added',icon:'layout',title:'Actual episode thumbnails',description:'Episode cards use the selected source’s per-episode stills when available, including lazy-loaded images. Spoiler Shield keeps future artwork hidden.'},
    {kind:'added',icon:'sparkles',title:'ALL · DUB · SUB',description:'Filter the episode list, Latest Episodes and Browse using explicit source badges observed this session. Unknown audio stays in ALL; the latest episode needs its own confirmed badge.',action:{label:'Browse anime',path:'/browse'}},
    {kind:'fixed',icon:'fix',title:'Reliable artwork after revisiting',description:'Cached SPA pages can render their episode list late. Bounded metadata refreshes fill the cards without reloading video, and a successful replacement image becomes visible after an earlier failure.'},
    {kind:'improved',icon:'shield',title:'Keep source sessions and private viewing intact',description:'Read-only image grants use the original isolated source session. Cookies stay there; private titles do not enter the session-only catalogue audio index.'},
   ]},


  {version:'2.0.1',date:'2026-10-30',title:'Stronger boundaries. A festive loading space.',
   summary:'Embedded Rust URL policy, software security controls and temporary Diwali × Halloween branding.',
   items:[
    {kind:'added',icon:'shield',title:'Embedded Rust source protection',description:'An import-free WebAssembly policy checks source URLs, navigation identity and local-network address access. It runs inside the app and remains active when ad blocking is off.'},
    {kind:'improved',icon:'shield',title:'Software and package hardening',description:'Strict trusted app-origin checks, bounded RPC inputs and active requests, an app content policy, and production controls against Node environment/inspector entry points. These reduce specific risks; they do not make every website or device safe.'},
    {kind:'added',icon:'sparkles',title:'Diwali × Halloween logo and icons',description:'A temporary lamp-gold, pumpkin-orange and violet mark appears in the app and running-window icon. It reverts on January 1, 2027, and follows an early palette opt-out. Installer and permanent shortcut branding stay standard.',action:{label:'Theme settings',path:'/settings/themes'}},
    {kind:'added',icon:'layout',title:'A temporary festive buffer',description:'A soft lamp-and-pumpkin loading animation replaces the cat through December. Reduced motion is respected; the cat automatically returns in January.'},
   ]},

  { version: '1.5.8', date: '2026-10-30', title: 'A calmer watch space. More ways to find your anime.',
    summary: 'Episode cards, broader search, automatic source recovery, private playback and a temporary Diwali × Halloween palette.',
    items: [
      { kind:'added',icon:'sparkles',title:'Diwali × Halloween, through December',description:'A dark midnight-violet palette with warm ivory text and amber highlights. Applied with this update until December 31, 2026, then your previous palette returns. Switch away earlier or select it manually later.',action:{label:'Theme settings',path:'/settings/themes'} },
      { kind:'improved',icon:'layout',title:'A clearer episode index',description:'Thumbnail cards, episode numbers, watched states and a distinct active episode. Search and list/grid choices remain; Spoiler Shield still hides future episode artwork and titles.' },
      { kind:'improved',icon:'fix',title:'Broader search and source recovery',description:'Discover nearby English, romaji and Japanese title matches. Missing episodes automatically try the other enabled TXT sources once, with a retry action when all are exhausted.' },
      { kind:'added',icon:'shield',title:'Incognito and private titles',description:'Use the header for a temporary session or Keep private for a title. New history, progress, insights, learned links and account sync are skipped. Private titles are excluded from new app-data backups. Existing remote records are not deleted.' },
      { kind:'fixed',icon:'sparkles',title:'Uncropped normal and 4K playback',description:'Repair inner video dimensions and offsets in focused players and embedded documents. Anime4K overlays follow transformed player containers while the source video and audio continue.' },
      { kind:'improved',icon:'shield',title:'Stronger popup protection and fresh filters',description:'Block same-site popups and off-site top-frame redirects. Cosmetic filters apply to the correct iframe. Lists refresh after 24 hours; Update filters is available in Privacy settings.',action:{label:'Privacy settings',path:'/settings/privacy'} },
      { kind: 'fixed', icon: 'layout', title: 'No whole-interface blur', description: 'Release highlights, dialogs, navigation overlays and menus now dim or cover their background without applying blur to the app.' },
      { kind: 'fixed', icon: 'shield', title: 'Stable Windows composition', description: 'The Windows interface now uses a software compositor to avoid driver presentation issues affecting text and buttons. This does not disable all hardware acceleration.' },
      { kind: 'improved', icon: 'sparkles', title: 'Keep GPU video processing', description: 'GPU video decoding, Anime4K WebGL and sender encoding remain available where supported. Graphics settings offers Stable or Accelerated UI; changes apply after restarting and stay on this device.', action: { label: 'Graphics settings', path: '/settings/graphics' } },
    ] },
  { version: '1.5.7', date: '2026-10-29', title: 'Cast with Chrome. Keep AniVerse sharp.',
    summary: 'Use Google Chrome’s TV discovery and tab casting when AniVerse’s direct receiver connection fails.',
    items: [
      { kind: 'added', icon: 'cast', title: 'Chrome-backed TV casting', description: 'Choose Cast to TV → Find TVs with Chrome. An isolated Chrome window receives the selected player and uses Chrome’s own TV discovery and tab-casting transport. Chrome must be installed.' },
      { kind: 'fixed', icon: 'layout', title: 'Sharp casting controls', description: 'Removed cast-dialog backdrop blur, kept the native chooser inside the player and prevented overlapping player menus. Opening the chooser does not change app zoom or Windows display mode.' },
      { kind: 'improved', icon: 'shield', title: 'Separate screen projection', description: 'Windows Miracast is an optional, clearly labelled route. Chrome casting shares the selected player rather than the Windows desktop; normal browser profile data is not copied.' },
      { kind: 'fixed', icon: 'fix', title: 'Reliable stop and receiver choices', description: 'Cancelled starts no longer reconnect later. Duplicate TV names require an explicit choice in Chrome’s Cast menu. Closing or leaving the companion stops the owned connection.' },
    ] },
  { version: '1.5.6', date: '2026-10-29', title: 'Casting, upscaling and playback timing fixes.',
    summary: 'Find Windows wireless displays, restore line effects and keep filtered video from falling behind playback.',
    items: [
      { kind: 'fixed', icon: 'cast', title: 'Windows wireless display support', description: 'Open the Windows Miracast chooser from either cast menu for TVs shown by Windows + K. Screen sharing and Google Cast have clearly separate controls.', action: { label: 'Choose an episode', path: '/library' } },
      { kind: 'fixed', icon: 'sparkles', title: 'Compatibility upscaling for website players', description: 'If direct Anime4K fails, choose Use compatibility upscaling. It processes a capture of the selected site view on your GPU while keeping source audio and controls. Protected video may still refuse capture.', action: { label: 'Player settings', path: '/settings/player' } },
      { kind: 'fixed', icon: 'fix', title: 'Darken and Thin shaders repaired', description: 'Corrected line-effect shader code that failed to compile under WebGL 1 and could stop upscaling across native and website sources.' },
      { kind: 'fixed', icon: 'history', title: 'Scaling keeps up with playback', description: 'Filtered frames no longer build a delayed GPU queue. Slow rendering switches to lighter processing, then the original picture if needed, while the original audio and media clock continue.' },
      { kind: 'improved', icon: 'fix', title: 'More reliable Google Cast discovery', description: 'Discovery scans active IPv4 interfaces, combines device records received in separate packets and resolves missing addresses instead of assigning unrelated devices.' },
    ] },
  { version: '1.5.3', date: '2026-10-29', title: 'A new layout. A visible way to cast.',
    summary: 'Choose how AniVerse is organised, cast from the episode page, and discover changes right here.',
    items: [
      { kind: 'improved', icon: 'layout', title: 'Three different interface layouts', description: 'Classic keeps the original rail. Studio adds a permanent navigation workspace. Cinema moves navigation to the top and episodes below a wide player.', action: { label: 'Choose your layout', path: '/settings/themes' } },
      { kind: 'fixed', icon: 'cast', title: 'Cast to TV on the episode page', description: 'A labelled TV button is visible above the player. Native videos cast directly; website episodes can mirror their player view and audio.', action: { label: 'Choose an episode', path: '/library' } },
      { kind: 'added', icon: 'history', title: 'What’s new, inside AniVerse', description: 'Release highlights appear after an update. Open the full, colour-coded changelog from the header or Settings at any time.', action: { label: 'View changelog', path: '/settings/changelog' } },
      { kind: 'improved', icon: 'shield', title: 'Casting stays on your device', description: 'Website mirroring captures the selected site view, not your desktop. Embedded FFmpeg prepares the TV stream; stop casting or leave the episode to end capture.' },
    ] },
  { version: '1.5.2', date: '2026-10-29', title: 'Anime4K and portable backups', summary: 'GPU video filtering, embedded 4K casting and Google Drive app-data backup.',
    items: [
      { kind: 'added', icon: 'sparkles', title: 'Anime4K upscaling', description: 'Six restoration/denoise presets with optional darken/thin line effects.', action: { label: 'Player settings', path: '/settings/player' } },
      { kind: 'added', icon: 'cloud', title: 'Google Drive import and export', description: 'Use your own Desktop OAuth JSON. The fixed AniVerse Sync folder and versioned backup format stay compatible across releases.', action: { label: 'Set up Drive', path: '/settings/drive' } },
      { kind: 'added', icon: 'cast', title: 'Embedded 4K processing', description: 'FFmpeg and FFprobe ship with AniVerse. Opened local videos can be processed on the sender into a 4K HEVC TV stream.' },
    ] },
  { version: '1.0.0', date: '2026-10-26', title: 'Your episode workspace', summary: 'Local tools for keeping track of what you watch.',
    items: [
      { kind: 'added', icon: 'history', title: 'Scenes, plans and local collection', description: 'Save scene notes, plan your week and match your own video files.', action: { label: 'Open workspace', path: '/workspace' } },
      { kind: 'added', icon: 'shield', title: 'Spoiler Shield and Subtitle Studio', description: 'Reveal app spoilers deliberately and customise captions in the native player.' },
    ] },
];
export const CURRENT_RELEASE = RELEASES[0]!;
export interface ChangelogState { version: string; seen: string | null; unread: boolean }
