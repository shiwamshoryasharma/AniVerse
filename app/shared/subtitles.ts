export interface CaptionCue {
  startTime: number;
  endTime: number;
  text: string;
}
export function subtitleTextToVtt(input: string): string {
  if (input.length > 2_000_000 || input.includes('\0')) throw new Error('Subtitle files must be text smaller than 2 MB.');
  const text = input
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!/\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}\s+-->\s+\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}/.test(text)) throw new Error('Choose a valid SRT or WebVTT subtitle file.');
  if (/^WEBVTT(?:\s|$)/.test(text)) return text + '\n';
  return 'WEBVTT\n\n' + text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2') + '\n';
}
export function subtitleLinesAt(cues: ArrayLike<CaptionCue>, time: number, offset: number): string[] {
  const at = time - offset;
  const lines: string[] = [];
  for (let index = 0; index < Math.min(cues.length, 15000); index++) {
    const cue = cues[index];
    if (cue.startTime <= at && cue.endTime > at) {
      lines.push(
        cue.text
          .replace(/<[^>]*>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>'),
      );
      if (lines.length >= 4) break;
    }
  }
  return lines;
}
