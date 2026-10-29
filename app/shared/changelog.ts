export type ChangeKind = 'added' | 'improved' | 'fixed';
export type ChangeIcon = 'layout' | 'cast' | 'sparkles' | 'cloud' | 'history' | 'shield' | 'fix';
export interface ReleaseNote {
  version: string; date: string; title: string; summary: string;
  items: { kind: ChangeKind; icon: ChangeIcon; title: string; description: string; action?: { label: string; path: string } }[];
}
export const RELEASES: ReleaseNote[] = [
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
