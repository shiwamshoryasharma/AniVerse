/** Watch metadata used only for the suggested local filename, never media authorization. */
export interface EpisodeDownloadContext {
  title: string;
  season?: number;
  episode: number;
}

export function episodeDownloadFilename(context: EpisodeDownloadContext): string | null {
  if (!context || typeof context !== 'object' || Object.keys(context).some(key => !['title', 'season', 'episode'].includes(key)) ||
      typeof context.title !== 'string' || !context.title.trim() || context.title.length > 300 ||
      !Number.isInteger(context.episode) || context.episode < 1 || context.episode > 10_000 ||
      (context.season !== undefined && (!Number.isInteger(context.season) || context.season < 1 || context.season > 99))) return null;
  let title = Array.from(context.title, character => {
    const code = character.codePointAt(0)!;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    const directionOverride = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    return control || directionOverride || /[<>:"/\\|?*]/.test(character) ? '_' : character;
  }).join('').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '');
  title = Array.from(title).slice(0, 100).join('').replace(/[ .]+$/g, '') || 'Series';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title)) title = '_' + title;
  return `${title} - S${String(context.season ?? 1).padStart(2, '0')}E${String(context.episode).padStart(2, '0')}.mp4`;
}