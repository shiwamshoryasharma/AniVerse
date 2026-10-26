import { describe, expect, it } from 'vitest';
import { subtitleTextToVtt, subtitleLinesAt } from '../../app/shared/subtitles';
describe('Subtitle Studio', () => {
  it('converts SRT timestamps while preserving Unicode caption text', () => {
    expect(subtitleTextToVtt('1\n00:00:01,250 --> 00:00:03,500\nHello 世界\n')).toContain('00:00:01.250 --> 00:00:03.500');
    expect(subtitleTextToVtt('WEBVTT\n\n00:01.000 --> 00:02.000\nHi')).toMatch(/^WEBVTT/);
  });
  it('rejects arbitrary documents and overlong input', () => {
    expect(() => subtitleTextToVtt('not a subtitle')).toThrow();
    expect(() => subtitleTextToVtt('x'.repeat(2_100_000))).toThrow();
  });
  it('uses an explicit subtitle offset and treats cue content as plain text', () => {
    const cues = [
      { startTime: 1, endTime: 3, text: '<b>Hello</b>' },
      { startTime: 3, endTime: 5, text: 'Next' },
    ];
    expect(subtitleLinesAt(cues, 2, 0)).toEqual(['Hello']);
    expect(subtitleLinesAt(cues, 2, 2)).toEqual([]);
    expect(subtitleLinesAt(cues, 4, 2)).toEqual(['Hello']);
  });
});
