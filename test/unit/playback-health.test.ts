import { describe, expect, it } from 'vitest';
import { playbackHealth, type PlaybackSample } from '../../app/shared/playback';

const sample = (at: number, time: number, total: number, dropped = 0): PlaybackSample => ({
  at, currentTime: time, paused: false, ended: false, readyState: 4, totalFrames: total, droppedFrames: dropped,
});

describe('playback health', () => {
  it('detects frozen video even while the media clock advances', () => {
    expect(playbackHealth(sample(1000, 10, 300), sample(5000, 14, 300)).state).toBe('stalled');
  });
  it('does not confuse a paused episode with a stall', () => {
    expect(playbackHealth(sample(1000, 10, 300), { ...sample(5000, 10, 300), paused: true }).state).toBe('paused');
  });
  it('reports low ready state as buffering', () => {
    expect(playbackHealth(null, { ...sample(1000, 0, 0), readyState: 2 }).state).toBe('buffering');
  });
  it('measures presented frames and dropped-frame rate over the latest interval', () => {
    const health = playbackHealth(sample(1000, 10, 300, 0), sample(5000, 14, 400, 20));
    expect(health.state).toBe('stuttering');
    expect(health.fps).toBe(20);
    expect(health.dropPercent).toBe(20);
  });
  it('resets frame-rate estimates across a backwards seek', () => {
    const health = playbackHealth(sample(1000, 100, 1000), sample(5000, 10, 100));
    expect(health.state).toBe('playing');
    expect(health.fps).toBeNull();
  });
  it('reports healthy playback and completion', () => {
    expect(playbackHealth(sample(1000, 10, 300), sample(5000, 14, 396)).state).toBe('playing');
    expect(playbackHealth(null, { ...sample(1000, 20, 500), ended: true }).state).toBe('ended');
  });
});
